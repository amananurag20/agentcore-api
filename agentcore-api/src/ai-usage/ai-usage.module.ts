import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AIUsageService } from './ai-usage.service';

@Module({
  imports: [PrismaModule],
  providers: [AIUsageService],
  exports: [AIUsageService],
})
export class AIUsageModule {}
