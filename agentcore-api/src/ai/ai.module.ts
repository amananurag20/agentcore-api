import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatService } from './chat.service';
import { EmbeddingsService } from './embeddings.service';

@Module({
  imports: [CryptoModule, PrismaModule],
  providers: [ChatService, EmbeddingsService],
  exports: [ChatService, EmbeddingsService],
})
export class AIModule {}
