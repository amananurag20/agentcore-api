import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { validateEnv } from '../config/env.validation';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { AppointmentReminderService } from './appointment-reminder.service';
import { AppointmentReminderDeliveryService } from './appointment-reminder-delivery.service';
import { AppointmentReminderWorker } from './appointment-reminder.worker';
import { AppointmentReminderRecoveryService } from './appointment-reminder-recovery.service';
import { AppointmentCalendarService } from './appointment-calendar.service';
import { AppointmentCalendarWorker } from './appointment-calendar.worker';
import { AppointmentCalendarRecoveryService } from './appointment-calendar-recovery.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    AuditModule,
    CryptoModule,
    PrismaModule,
    QueueModule,
  ],
  providers: [
    AppointmentReminderDeliveryService,
    AppointmentReminderService,
    AppointmentReminderRecoveryService,
    AppointmentReminderWorker,
    AppointmentCalendarService,
    AppointmentCalendarWorker,
    AppointmentCalendarRecoveryService,
  ],
})
export class AppointmentBookingWorkerModule {}
