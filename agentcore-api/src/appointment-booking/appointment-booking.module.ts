import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import {
  AppointmentBookingController,
  PublicAppointmentBookingController,
} from './appointment-booking.controller';
import { AppointmentBookingService } from './appointment-booking.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';
import { AppointmentReminderService } from './appointment-reminder.service';

@Module({
  imports: [AuditModule, PrismaModule, QueueModule],
  controllers: [
    AppointmentBookingController,
    PublicAppointmentBookingController,
  ],
  providers: [
    AppointmentBookingService,
    AppointmentReminderQueueService,
    AppointmentReminderService,
  ],
  exports: [AppointmentBookingService],
})
export class AppointmentBookingModule {}
