import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AIAdapterRegistryService } from './adapters/ai-adapter-registry.service';
import { ChatService } from './chat.service';
import { EmbeddingsService } from './embeddings.service';

@Module({
  imports: [CryptoModule, PrismaModule],
  providers: [AIAdapterRegistryService, ChatService, EmbeddingsService],
  exports: [ChatService, EmbeddingsService],
})
export class AIModule {}
