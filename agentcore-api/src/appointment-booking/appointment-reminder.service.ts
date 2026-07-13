import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentReminderDeliveryService } from './appointment-reminder-delivery.service';
import { AppointmentReminderJobData } from './appointment-reminder-queue.service';

@Injectable()
export class AppointmentReminderService {
  private readonly logger = new Logger(AppointmentReminderService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly deliveryService: AppointmentReminderDeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  async processReminder(data: AppointmentReminderJobData) {
    const reminder = await this.prisma.appointmentReminder.findUnique({
      where: { id: data.reminderId },
      include: {
        booking: { include: { service: true, staff: true } },
      },
    });
    if (!reminder) return;
    if (reminder.dueAt.toISOString() !== data.expectedDueAt) return;

    const claimed = await this.prisma.appointmentReminder.updateMany({
      where: { id: reminder.id, status: { in: ['pending', 'failed'] } },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count === 0) return;

    const booking = reminder.booking;
    if (!['pending', 'confirmed'].includes(booking.status)) {
      await this.finishSkipped(reminder.id, booking.organizationId, booking.id);
      return;
    }

    try {
      const deliveries = await this.deliveryService.deliver(
        booking,
        reminder.reminderType,
      );
      if (!deliveries.length) {
        await this.prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: {
            status: 'skipped',
            lastError:
              'No configured delivery channel matched customer contact details',
          },
        });
        return;
      }

      await this.prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: {
          status: 'sent',
          channels: deliveries.map((delivery) => delivery.channel),
          providerMessageIds:
            this.deliveryService.toProviderMessageIds(deliveries),
          sentAt: new Date(),
        },
      });
      await this.auditService.record({
        organizationId: booking.organizationId,
        action: 'appointment.reminder_sent',
        entityType: 'appointment_booking',
        entityId: booking.id,
        metadata: {
          reminderId: reminder.id,
          reminderType: reminder.reminderType,
          channels: deliveries.map((delivery) => delivery.channel),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: { status: 'failed', lastError: message.slice(0, 2000) },
      });
      this.logger.error(
        `Appointment reminder ${reminder.id} failed: ${message}`,
      );
      throw error;
    }
  }

  private async finishSkipped(
    reminderId: string,
    organizationId: string,
    bookingId: string,
  ) {
    await this.prisma.appointmentReminder.update({
      where: { id: reminderId },
      data: { status: 'skipped', lastError: 'Booking is no longer active' },
    });
    await this.auditService.record({
      organizationId,
      action: 'appointment.reminder_skipped',
      entityType: 'appointment_booking',
      entityId: bookingId,
      metadata: { reminderId, reason: 'booking_not_active' },
    });
  }
}
