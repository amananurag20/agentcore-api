import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import {
  AppointmentBookingController,
  PublicAppointmentBookingController,
} from './appointment-booking.controller';
import { AppointmentBookingService } from './appointment-booking.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';
import { AppointmentTimezoneService } from './appointment-timezone.service';

@Module({
  imports: [AuditModule, PrismaModule, QueueModule, RateLimitModule],
  controllers: [
    AppointmentBookingController,
    PublicAppointmentBookingController,
  ],
  providers: [
    AppointmentBookingService,
    AppointmentReminderQueueService,
    AppointmentTimezoneService,
  ],
  exports: [AppointmentBookingService],
})
export class AppointmentBookingModule {}
