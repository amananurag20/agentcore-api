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
import { KnowledgeAlertService } from './knowledge-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionCancelledError } from './knowledge-ingestion.types';

@Injectable()
export class KnowledgeIngestionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeIngestionWorker.name);
  private worker: Worker<KnowledgeIngestionJobData> | null = null;
  private connection: ConnectionOptions | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly alertService: KnowledgeAlertService,
    private readonly prisma: PrismaService,
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
      if (job?.data) void this.alertService.ingestionFailed(job.data, error);
      if (job?.data.runId) void this.markFailed(job, error);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<KnowledgeIngestionJobData>) {
    if (job.name !== KNOWLEDGE_INGESTION_JOB) {
      return;
    }

    if (job.data.runId) {
      await this.prisma.knowledgeIngestionRun.update({
        where: { id: job.data.runId },
        data: {
          status: 'processing',
          stage: 'starting',
          attempt: job.attemptsMade + 1,
          startedAt: new Date(),
          errorMessage: null,
        },
      });
    }

    try {
      await this.ingestionService.ingestSource(job.data);
    } catch (error) {
      if (error instanceof KnowledgeIngestionCancelledError) {
        job.discard();
        return;
      }
      throw error;
    }

    this.logger.log(`Ingested knowledge source ${job.data.sourceId}`);
  }

  private async markFailed(job: Job<KnowledgeIngestionJobData>, error: Error) {
    const runId = job.data.runId;
    if (!runId) return;
    if (error instanceof KnowledgeIngestionCancelledError) return;
    const attempts = job.opts.attempts ?? 1;
    const terminal = job.attemptsMade >= attempts;
    await this.prisma.knowledgeIngestionRun.update({
      where: { id: runId },
      data: {
        status: terminal ? 'dead_letter' : 'failed',
        stage: terminal ? 'dead_letter' : 'retry_wait',
        attempt: job.attemptsMade,
        completedAt: terminal ? new Date() : null,
        errorMessage: error.message,
      },
    });
  }
}
