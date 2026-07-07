import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingsService } from './embeddings.service';

@Module({
  imports: [CryptoModule, PrismaModule],
  providers: [EmbeddingsService],
  exports: [EmbeddingsService],
})
export class AIModule {}
