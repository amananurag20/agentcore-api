import { Injectable, Logger } from '@nestjs/common';
import { AppointmentBooking } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentReminderJobData } from './appointment-reminder-queue.service';

@Injectable()
export class AppointmentReminderService {
  private readonly logger = new Logger(AppointmentReminderService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async processReminder(data: AppointmentReminderJobData) {
    const booking = await this.prisma.appointmentBooking.findFirst({
      where: {
        id: data.bookingId,
        organizationId: data.organizationId,
      },
    });

    if (!booking) {
      this.logger.warn(`Appointment reminder skipped. Booking not found.`);
      return;
    }

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      await this.recordSkippedReminder(booking, data, 'booking_not_active');
      return;
    }

    this.deliverReminder(booking, data);

    await this.auditService.record({
      organizationId: booking.organizationId,
      action: 'appointment.reminder_sent',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: {
        reminderType: data.reminderType,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        provider: 'log',
      },
    });
  }

  private deliverReminder(
    booking: AppointmentBooking,
    data: AppointmentReminderJobData,
  ) {
    this.logger.log(
      [
        `Appointment ${data.reminderType} reminder`,
        `booking=${booking.id}`,
        `customer=${booking.customerName}`,
        `email=${booking.customerEmail ?? 'none'}`,
        `phone=${booking.customerPhone ?? 'none'}`,
        `startAt=${booking.startAt.toISOString()}`,
      ].join(' '),
    );
  }

  private async recordSkippedReminder(
    booking: AppointmentBooking,
    data: AppointmentReminderJobData,
    reason: string,
  ) {
    await this.auditService.record({
      organizationId: booking.organizationId,
      action: 'appointment.reminder_skipped',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: {
        reminderType: data.reminderType,
        reason,
        status: booking.status,
      },
    });
  }
}
