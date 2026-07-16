import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AppointmentBookingModule } from '../appointment-booking/appointment-booking.module';
import { AuditModule } from '../audit/audit.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import {
  CustomerChatController,
  CustomerChatWidgetController,
} from './customer-chat.controller';
import { CustomerChatService } from './customer-chat.service';
import { CustomerChatRealtimeService } from './customer-chat-realtime.service';
import { CustomerChatGateway } from './customer-chat.gateway';

@Module({
  imports: [
    AIModule,
    AppointmentBookingModule,
    AuditModule,
    KnowledgeModule,
    PrismaModule,
    RateLimitModule,
  ],
  controllers: [CustomerChatController, CustomerChatWidgetController],
  providers: [
    CustomerChatService,
    CustomerChatRealtimeService,
    CustomerChatGateway,
  ],
})
export class CustomerChatModule {}
