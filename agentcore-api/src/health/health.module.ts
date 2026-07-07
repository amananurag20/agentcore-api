import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PrismaModule, QueueModule, StorageModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
