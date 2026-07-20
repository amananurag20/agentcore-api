import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AIUsageModule } from '../ai-usage/ai-usage.module';
import { AIAdapterRegistryService } from './adapters/ai-adapter-registry.service';
import { ChatService } from './chat.service';
import { EmbeddingsService } from './embeddings.service';
import { ProviderEndpointPolicyModule } from './provider-endpoint-policy.module';

@Module({
  imports: [
    AIUsageModule,
    CryptoModule,
    PrismaModule,
    ProviderEndpointPolicyModule,
  ],
  providers: [AIAdapterRegistryService, ChatService, EmbeddingsService],
  exports: [AIAdapterRegistryService, ChatService, EmbeddingsService],
})
export class AIModule {}
