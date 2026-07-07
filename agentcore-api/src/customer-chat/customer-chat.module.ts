import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  CustomerChatController,
  CustomerChatWidgetController,
} from './customer-chat.controller';
import { CustomerChatService } from './customer-chat.service';

@Module({
  imports: [AIModule, KnowledgeModule, PrismaModule],
  controllers: [CustomerChatController, CustomerChatWidgetController],
  providers: [CustomerChatService],
})
export class CustomerChatModule {}
