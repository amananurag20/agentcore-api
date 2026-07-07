import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
