import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
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

@Module({
  imports: [AIModule, AuditModule, CryptoModule, KnowledgeModule, PrismaModule],
  controllers: [
    VoiceReceptionistController,
    VoiceReceptionistWebhookController,
  ],
  providers: [VoiceReceptionistService, VoiceOutboundService],
})
export class VoiceReceptionistModule {}
