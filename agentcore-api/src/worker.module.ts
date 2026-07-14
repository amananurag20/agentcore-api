import { Module } from '@nestjs/common';
import { AppointmentBookingWorkerModule } from './appointment-booking/appointment-booking-worker.module';
import { KnowledgeIngestionWorkerModule } from './knowledge-ingestion/knowledge-ingestion-worker.module';
import { WhatsAppAssistantWorkerModule } from './whatsapp-assistant/whatsapp-assistant-worker.module';

@Module({
  imports: [
    AppointmentBookingWorkerModule,
    KnowledgeIngestionWorkerModule,
    WhatsAppAssistantWorkerModule,
  ],
})
export class WorkerModule {}
