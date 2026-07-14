import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AppointmentBookingModule } from '../appointment-booking/appointment-booking.module';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import {
  WhatsAppAssistantController,
  WhatsAppAssistantWebhookController,
} from './whatsapp-assistant.controller';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';
import { WhatsAppInboundQueueService } from './whatsapp-inbound-queue.service';

@Module({
  imports: [
    AIModule,
    AppointmentBookingModule,
    AuditModule,
    CryptoModule,
    KnowledgeModule,
    PrismaModule,
    QueueModule,
  ],
  controllers: [
    WhatsAppAssistantController,
    WhatsAppAssistantWebhookController,
  ],
  providers: [
    WhatsAppAssistantService,
    WhatsAppInboundQueueService,
    WhatsAppOutboundService,
  ],
  exports: [WhatsAppAssistantService],
})
export class WhatsAppAssistantModule {}
