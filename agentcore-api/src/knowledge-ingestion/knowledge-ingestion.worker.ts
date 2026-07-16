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
  KNOWLEDGE_REEMBED_ORGANIZATION_JOB,
} from '../queue/queue.constants';
import { parseRedisConnection } from '../queue/redis-connection';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import {
  KnowledgeIngestionJobData,
  KnowledgeOrganizationReembeddingJobData,
} from './knowledge-ingestion.types';
import { KnowledgeAlertService } from './knowledge-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionCancelledError } from './knowledge-ingestion.types';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';

type KnowledgeWorkerJobData =
  KnowledgeIngestionJobData | KnowledgeOrganizationReembeddingJobData;

@Injectable()
export class KnowledgeIngestionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeIngestionWorker.name);
  private worker: Worker<KnowledgeWorkerJobData> | null = null;
  private connection: ConnectionOptions | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly alertService: KnowledgeAlertService,
    private readonly prisma: PrismaService,
    private readonly ingestionQueue: KnowledgeIngestionQueueService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      return;
    }

    this.connection = parseRedisConnection(redisUrl);
    this.worker = new Worker<KnowledgeWorkerJobData>(
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
      if (job?.name === KNOWLEDGE_INGESTION_JOB && 'sourceId' in job.data) {
        void this.alertService.ingestionFailed(job.data, error);
        if (job.data.runId)
          void this.markFailed(job as Job<KnowledgeIngestionJobData>, error);
      }
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<KnowledgeWorkerJobData>) {
    if (job.name === KNOWLEDGE_REEMBED_ORGANIZATION_JOB) {
      return this.scheduleOrganizationReembedding(
        job.data as KnowledgeOrganizationReembeddingJobData,
      );
    }
    if (job.name !== KNOWLEDGE_INGESTION_JOB) {
      return;
    }
    const ingestionData = job.data as KnowledgeIngestionJobData;

    if (ingestionData.runId) {
      await this.prisma.knowledgeIngestionRun.update({
        where: { id: ingestionData.runId },
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
      await this.ingestionService.ingestSource(ingestionData);
    } catch (error) {
      if (error instanceof KnowledgeIngestionCancelledError) {
        job.discard();
        return;
      }
      throw error;
    }

    this.logger.log(`Ingested knowledge source ${ingestionData.sourceId}`);
  }

  private async scheduleOrganizationReembedding(
    data: KnowledgeOrganizationReembeddingJobData,
  ): Promise<void> {
    const batchSize = 100;
    let scheduled = 0;
    while (true) {
      const sources = await this.prisma.knowledgeSource.findMany({
        where: { organizationId: data.organizationId, status: 'ready' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (sources.length === 0) break;

      for (const source of sources) {
        const claimed = await this.prisma.knowledgeSource.updateMany({
          where: { id: source.id, status: 'ready' },
          data: { status: 'pending', errorMessage: null },
        });
        if (claimed.count !== 1) continue;
        try {
          await this.ingestionQueue.enqueue({
            organizationId: data.organizationId,
            sourceId: source.id,
            reason: data.reason,
          });
          scheduled += 1;
        } catch (error) {
          await this.prisma.knowledgeSource.update({
            where: { id: source.id },
            data: {
              status: 'failed',
              errorMessage: `Knowledge re-embedding could not be scheduled: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
        }
      }
    }
    this.logger.log(
      `Scheduled ${scheduled} sources for re-embedding in organization ${data.organizationId}`,
    );
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
