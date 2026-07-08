import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  AppointmentBookingController,
  PublicAppointmentBookingController,
} from './appointment-booking.controller';
import { AppointmentBookingService } from './appointment-booking.service';

@Module({
  imports: [AuditModule, PrismaModule],
  controllers: [
    AppointmentBookingController,
    PublicAppointmentBookingController,
  ],
  providers: [AppointmentBookingService],
  exports: [AppointmentBookingService],
})
export class AppointmentBookingModule {}
