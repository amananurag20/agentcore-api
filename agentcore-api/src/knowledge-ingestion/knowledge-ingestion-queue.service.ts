import { Injectable } from '@nestjs/common';
import {
  KNOWLEDGE_INGESTION_JOB,
  KNOWLEDGE_INGESTION_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { KnowledgeIngestionJobData } from './knowledge-ingestion.types';

@Injectable()
export class KnowledgeIngestionQueueService {
  constructor(private readonly queueService: QueueService) {}

  async enqueue(data: KnowledgeIngestionJobData) {
    return this.queueService.add(
      KNOWLEDGE_INGESTION_QUEUE,
      KNOWLEDGE_INGESTION_JOB,
      data,
      {
        jobId: `${data.sourceId}:${data.reason}`,
      },
    );
  }

  isEnabled(): boolean {
    return this.queueService.isEnabled();
  }
}
