import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { KnowledgeIngestionModule } from '../knowledge-ingestion/knowledge-ingestion.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AIProvidersController } from './ai-providers.controller';
import { AIProvidersService } from './ai-providers.service';

@Module({
  imports: [AuditModule, CryptoModule, KnowledgeIngestionModule, PrismaModule],
  controllers: [AIProvidersController],
  providers: [AIProvidersService],
  exports: [AIProvidersService],
})
export class AIProvidersModule {}
