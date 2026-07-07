import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { TextChunkerService } from './text-chunker.service';

@Module({
  imports: [PrismaModule, QueueModule],
  providers: [
    KnowledgeIngestionQueueService,
    KnowledgeIngestionService,
    TextChunkerService,
  ],
  exports: [KnowledgeIngestionQueueService, KnowledgeIngestionService],
})
export class KnowledgeIngestionModule {}
