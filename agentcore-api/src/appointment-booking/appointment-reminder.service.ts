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
      await this.finishSkipped(
        reminder.id,
        booking.organizationId,
        booking.id,
        'booking_not_active',
      );
      return;
    }
    if (booking.startAt <= new Date()) {
      await this.finishSkipped(
        reminder.id,
        booking.organizationId,
        booking.id,
        'appointment_already_started',
      );
      return;
    }

    try {
      const deliveredChannels = new Set(reminder.channels);
      const providerMessageIds =
        reminder.providerMessageIds &&
        typeof reminder.providerMessageIds === 'object' &&
        !Array.isArray(reminder.providerMessageIds)
          ? { ...reminder.providerMessageIds }
          : {};
      const deliveries = await this.deliveryService.deliver(
        booking,
        reminder.reminderType,
        deliveredChannels,
        async (delivery) => {
          deliveredChannels.add(delivery.channel);
          providerMessageIds[delivery.channel] =
            delivery.providerMessageId ?? delivery.provider;
          await this.prisma.appointmentReminder.update({
            where: { id: reminder.id },
            data: {
              channels: [...deliveredChannels],
              providerMessageIds,
            },
          });
        },
      );
      if (!deliveries.length && deliveredChannels.size === 0) {
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
          channels: [...deliveredChannels],
          providerMessageIds,
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
          channels: [...deliveredChannels],
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
    reason: 'booking_not_active' | 'appointment_already_started',
  ) {
    await this.prisma.appointmentReminder.update({
      where: { id: reminderId },
      data: {
        status: 'skipped',
        lastError:
          reason === 'appointment_already_started'
            ? 'Appointment has already started'
            : 'Booking is no longer active',
      },
    });
    await this.auditService.record({
      organizationId,
      action: 'appointment.reminder_skipped',
      entityType: 'appointment_booking',
      entityId: bookingId,
      metadata: { reminderId, reason },
    });
  }
}
