import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Worker } from 'bullmq';
import {
  KNOWLEDGE_INGESTION_JOB,
  KNOWLEDGE_INGESTION_QUEUE,
} from '../queue/queue.constants';
import { parseRedisConnection } from '../queue/redis-connection';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeIngestionJobData } from './knowledge-ingestion.types';

@Injectable()
export class KnowledgeIngestionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeIngestionWorker.name);
  private worker: Worker<KnowledgeIngestionJobData> | null = null;
  private connection: ConnectionOptions | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestionService: KnowledgeIngestionService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      return;
    }

    this.connection = parseRedisConnection(redisUrl);
    this.worker = new Worker<KnowledgeIngestionJobData>(
      KNOWLEDGE_INGESTION_QUEUE,
      (job) => this.process(job),
      {
        connection: this.connection,
        concurrency:
          this.configService.get<number>(
            'KNOWLEDGE_INGESTION_QUEUE_CONCURRENCY',
          ) ?? 2,
        prefix: this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore',
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Knowledge ingestion job failed: ${job?.id ?? 'unknown'}`,
        error.stack,
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<KnowledgeIngestionJobData>) {
    if (job.name !== KNOWLEDGE_INGESTION_JOB) {
      return;
    }

    await this.ingestionService.ingestSource(job.data);

    this.logger.log(`Ingested knowledge source ${job.data.sourceId}`);
  }
}
