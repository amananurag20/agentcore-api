import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AppointmentBookingModule } from '../appointment-booking/appointment-booking.module';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  VoiceReceptionistController,
  VoiceReceptionistWebhookController,
} from './voice-receptionist.controller';
import { VoiceReceptionistService } from './voice-receptionist.service';
import { VoiceOutboundService } from './voice-outbound.service';
import { VoiceNotificationService } from './voice-notification.service';
import { VoiceConversationRelayGateway } from './voice-conversation-relay.gateway';
import { VoiceRuntimeService } from './voice-runtime.service';
import { VoiceSoftphoneService } from './voice-softphone.service';
import { VoiceRetentionService } from './voice-retention.service';

@Module({
  imports: [
    AIModule,
    AppointmentBookingModule,
    AuditModule,
    CryptoModule,
    KnowledgeModule,
    PrismaModule,
  ],
  controllers: [
    VoiceReceptionistController,
    VoiceReceptionistWebhookController,
  ],
  providers: [
    VoiceReceptionistService,
    VoiceOutboundService,
    VoiceNotificationService,
    VoiceConversationRelayGateway,
    VoiceRuntimeService,
    VoiceSoftphoneService,
    VoiceRetentionService,
  ],
})
export class VoiceReceptionistModule {}
