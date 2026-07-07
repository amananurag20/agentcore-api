import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, JobsOptions, Queue } from 'bullmq';
import { parseRedisConnection } from './redis-connection';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: ConnectionOptions | null;
  private readonly queues = new Map<string, Queue>();
  private readonly prefix: string;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.prefix = this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore';

    this.connection = redisUrl ? parseRedisConnection(redisUrl) : null;
  }

  isEnabled(): boolean {
    return Boolean(this.connection);
  }

  async add<TData>(
    queueName: string,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ) {
    if (!this.connection) {
      return null;
    }

    return this.getQueue(queueName).add(jobName, data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: {
        age: 60 * 60 * 24,
        count: 1000,
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 7,
        count: 5000,
      },
      ...options,
    });
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private getQueue(queueName: string): Queue {
    const existingQueue = this.queues.get(queueName);

    if (existingQueue) {
      return existingQueue;
    }

    const queue = new Queue(queueName, {
      connection: this.connection!,
      prefix: this.prefix,
    });
    this.queues.set(queueName, queue);

    return queue;
  }
}
