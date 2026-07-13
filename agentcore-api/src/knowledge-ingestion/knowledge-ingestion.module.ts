import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeFileExtractorService } from './knowledge-file-extractor.service';
import { KnowledgeClassificationService } from './knowledge-classification.service';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { TextChunkerService } from './text-chunker.service';
import { UrlScraperService } from './url-scraper.service';

@Module({
  imports: [AIModule, AuditModule, PrismaModule, QueueModule, StorageModule],
  providers: [
    KnowledgeFileExtractorService,
    KnowledgeClassificationService,
    KnowledgeIngestionQueueService,
    KnowledgeIngestionService,
    TextChunkerService,
    UrlScraperService,
  ],
  exports: [KnowledgeIngestionQueueService, KnowledgeIngestionService],
})
export class KnowledgeIngestionModule {}
