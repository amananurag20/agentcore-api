import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  KNOWLEDGE_INGESTION_JOB,
  KNOWLEDGE_INGESTION_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { KnowledgeIngestionJobData } from './knowledge-ingestion.types';

@Injectable()
export class KnowledgeIngestionQueueService {
  constructor(
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueue(data: KnowledgeIngestionJobData) {
    const existing = await this.prisma.knowledgeIngestionRun.findFirst({
      where: {
        sourceId: data.sourceId,
        status: { in: ['queued', 'processing'] },
        cancellationRequestedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const run = await this.prisma.knowledgeIngestionRun.create({
      data: {
        organizationId: data.organizationId,
        sourceId: data.sourceId,
        reason: data.reason,
        maxAttempts: 3,
      },
    });
    const jobId = `knowledge-${run.id}`;
    try {
      await this.queueService.add(
        KNOWLEDGE_INGESTION_QUEUE,
        KNOWLEDGE_INGESTION_JOB,
        { ...data, runId: run.id },
        { jobId },
      );
      return this.prisma.knowledgeIngestionRun.update({
        where: { id: run.id },
        data: { queueJobId: jobId },
      });
    } catch (error) {
      await this.prisma.knowledgeIngestionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          stage: 'queue_publish',
          completedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async requestCancellation(sourceId: string) {
    const runs = await this.prisma.knowledgeIngestionRun.findMany({
      where: { sourceId, status: { in: ['queued', 'processing'] } },
    });
    const now = new Date();
    await this.prisma.knowledgeIngestionRun.updateMany({
      where: { id: { in: runs.map((run) => run.id) } },
      data: { cancellationRequestedAt: now },
    });
    for (const run of runs) {
      if (!run.queueJobId || run.status === 'processing') continue;
      await this.queueService.remove(KNOWLEDGE_INGESTION_QUEUE, run.queueJobId);
      await this.prisma.knowledgeIngestionRun.update({
        where: { id: run.id },
        data: {
          status: 'cancelled',
          stage: 'cancelled',
          completedAt: now,
        },
      });
    }
    return runs.length;
  }

  isEnabled(): boolean {
    return this.queueService.isEnabled();
  }
}
