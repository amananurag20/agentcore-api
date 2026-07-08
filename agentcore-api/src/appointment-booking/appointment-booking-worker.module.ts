import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { AppointmentReminderService } from './appointment-reminder.service';
import { AppointmentReminderWorker } from './appointment-reminder.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    AuditModule,
    PrismaModule,
  ],
  providers: [AppointmentReminderService, AppointmentReminderWorker],
})
export class AppointmentBookingWorkerModule {}
