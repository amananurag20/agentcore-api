import { Module } from '@nestjs/common';
import { AppointmentBookingWorkerModule } from './appointment-booking/appointment-booking-worker.module';
import { KnowledgeIngestionWorkerModule } from './knowledge-ingestion/knowledge-ingestion-worker.module';

@Module({
  imports: [AppointmentBookingWorkerModule, KnowledgeIngestionWorkerModule],
})
export class WorkerModule {}
