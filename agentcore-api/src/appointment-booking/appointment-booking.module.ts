import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import {
  AppointmentBookingController,
  PublicAppointmentBookingController,
  AppointmentCalendarController,
  AppointmentCalendarOAuthController,
} from './appointment-booking.controller';
import { AppointmentBookingService } from './appointment-booking.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';
import { AppointmentTimezoneService } from './appointment-timezone.service';
import { AppointmentCalendarService } from './appointment-calendar.service';

@Module({
  imports: [
    AuditModule,
    CryptoModule,
    PrismaModule,
    QueueModule,
    RateLimitModule,
  ],
  controllers: [
    AppointmentBookingController,
    PublicAppointmentBookingController,
    AppointmentCalendarController,
    AppointmentCalendarOAuthController,
  ],
  providers: [
    AppointmentBookingService,
    AppointmentReminderQueueService,
    AppointmentTimezoneService,
    AppointmentCalendarService,
  ],
  exports: [AppointmentBookingService, AppointmentCalendarService],
})
export class AppointmentBookingModule {}
