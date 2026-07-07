import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';

@Module({
  imports: [QueueModule],
  providers: [KnowledgeIngestionQueueService],
  exports: [KnowledgeIngestionQueueService],
})
export class KnowledgeIngestionModule {}
