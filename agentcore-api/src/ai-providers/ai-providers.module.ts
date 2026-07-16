import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AIUsageModule } from '../ai-usage/ai-usage.module';
import { CryptoModule } from '../crypto/crypto.module';
import { KnowledgeIngestionModule } from '../knowledge-ingestion/knowledge-ingestion.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderEndpointPolicyModule } from '../ai/provider-endpoint-policy.module';
import { AIProvidersController } from './ai-providers.controller';
import { AIProvidersService } from './ai-providers.service';

@Module({
  imports: [
    AIUsageModule,
    AuditModule,
    CryptoModule,
    KnowledgeIngestionModule,
    PrismaModule,
    ProviderEndpointPolicyModule,
  ],
  controllers: [AIProvidersController],
  providers: [AIProvidersService],
  exports: [AIProvidersService],
})
export class AIProvidersModule {}
