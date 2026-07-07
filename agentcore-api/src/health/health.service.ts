import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { S3StorageService } from '../storage/s3-storage.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly storageService: S3StorageService,
  ) {}

  async getHealth() {
    const [database, redis, storage] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.storageService.getHealth(),
    ]);
    const status =
      database.status === 'ok' &&
      (redis.status === 'ok' || redis.status === 'disabled') &&
      (storage.status === 'ok' || storage.status === 'disabled')
        ? 'ok'
        : 'degraded';

    return {
      status,
      database: database.status,
      redis,
      queue: {
        status: this.queueService.isEnabled() ? 'enabled' : 'disabled',
        prefix: this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore',
      },
      storage,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return { status: 'error' };
    }
  }

  private async checkRedis() {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      return { status: 'disabled' };
    }

    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);

    try {
      await redis.connect();
      await redis.ping();
      return { status: 'ok' };
    } catch {
      return { status: 'error' };
    } finally {
      redis.disconnect();
    }
  }
}
