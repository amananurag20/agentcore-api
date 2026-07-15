import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { KnowledgeIngestionModule } from '../knowledge-ingestion/knowledge-ingestion.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import {
  InternalMemoryController,
  KnowledgeController,
} from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeSettingsService } from './knowledge-settings.service';

@Module({
  imports: [
    AIModule,
    AuditModule,
    CryptoModule,
    KnowledgeIngestionModule,
    PolicyModule,
    PrismaModule,
    StorageModule,
  ],
  controllers: [KnowledgeController, InternalMemoryController],
  providers: [KnowledgeService, KnowledgeSettingsService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
