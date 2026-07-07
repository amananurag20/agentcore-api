import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AIProvidersController } from './ai-providers.controller';
import { AIProvidersService } from './ai-providers.service';

@Module({
  imports: [CryptoModule, PrismaModule],
  controllers: [AIProvidersController],
  providers: [AIProvidersService],
  exports: [AIProvidersService],
})
export class AIProvidersModule {}
