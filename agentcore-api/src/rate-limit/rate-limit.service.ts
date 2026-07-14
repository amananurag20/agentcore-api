import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

type InMemoryLimit = {
  count: number;
  expiresAt: number;
};

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly fallbackLimits = new Map<string, InMemoryLimit>();
  private readonly prefix: string;
  private readonly redis: Redis | null;
  private readonly failClosed: boolean;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.prefix = this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore';
    this.failClosed =
      this.configService.get<boolean>('RATE_LIMIT_FAIL_CLOSED') ??
      this.configService.get<string>('NODE_ENV') === 'production';
    this.redis = redisUrl
      ? new Redis(redisUrl, { maxRetriesPerRequest: 1 })
      : null;
    this.redis?.on('error', () => undefined);
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
    message = 'Too many requests. Please try again later.',
  ) {
    if (limit <= 0 || windowSeconds <= 0) {
      return;
    }

    const count = await this.consumeWithAvailableStore(key, windowSeconds);

    if (count > limit) {
      throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit();
  }

  private async consumeRedis(key: string, windowSeconds: number) {
    const redisKey = `${this.prefix}:rate-limit:${key}`;
    const count = await this.redis!.incr(redisKey);

    if (count === 1) {
      await this.redis!.expire(redisKey, windowSeconds);
    }

    return count;
  }

  private async consumeWithAvailableStore(key: string, windowSeconds: number) {
    if (!this.redis) {
      if (this.failClosed) {
        throw new HttpException(
          'Rate limiting is temporarily unavailable.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return this.consumeInMemory(key, windowSeconds);
    }

    try {
      return await this.consumeRedis(key, windowSeconds);
    } catch {
      if (this.failClosed) {
        throw new HttpException(
          'Rate limiting is temporarily unavailable.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return this.consumeInMemory(key, windowSeconds);
    }
  }

  private consumeInMemory(key: string, windowSeconds: number) {
    const now = Date.now();
    const existing = this.fallbackLimits.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.cleanupExpired(now);
      this.fallbackLimits.set(key, {
        count: 1,
        expiresAt: now + windowSeconds * 1000,
      });
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  private cleanupExpired(now: number) {
    if (this.fallbackLimits.size < 1000) {
      return;
    }

    for (const [key, value] of this.fallbackLimits.entries()) {
      if (value.expiresAt <= now) {
        this.fallbackLimits.delete(key);
      }
    }
  }
}
