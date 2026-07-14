import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.validation';
import { WhatsAppAssistantModule } from './whatsapp-assistant.module';
import { WhatsAppInboundWorker } from './whatsapp-inbound.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    WhatsAppAssistantModule,
  ],
  providers: [WhatsAppInboundWorker],
})
export class WhatsAppAssistantWorkerModule {}
