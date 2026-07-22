import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APPLICATION_DEFAULTS } from '../config/application-defaults';
import {
  APPOINTMENT_REMINDER_JOB,
  APPOINTMENT_REMINDER_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';

export type AppointmentReminderJobData = {
  reminderId: string;
  expectedDueAt: string;
};

export function appointmentReminderJobId(
  reminderId: string,
  dueAt: Date,
): string {
  return `${reminderId}-${dueAt.getTime()}`;
}

@Injectable()
export class AppointmentReminderQueueService {
  constructor(
    _configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {
    void _configService;
  }

  async enqueueBookingReminders(input: {
    bookingId: string;
    organizationId: string;
    serviceId?: string;
    startAt: Date;
    timezone?: string;
  }) {
    await this.cancelBookingReminders(input.bookingId);
    const now = new Date();
    const policy = await this.prisma.appointmentBookingPolicy.findUnique({
      where: { organizationId: input.organizationId },
    });
    const service = input.serviceId
      ? await this.prisma.appointmentService.findUnique({
          where: { id: input.serviceId },
          select: { reminderOffsetsMinutes: true },
        })
      : null;
    const configuredOffsets = service?.reminderOffsetsMinutes.length
      ? service.reminderOffsetsMinutes
      : policy?.reminderOffsetsMinutes?.length
        ? policy.reminderOffsetsMinutes
        : this.getReminderOffsets();
    const offsets = [0, ...new Set(configuredOffsets)].sort(
      (left, right) => right - left,
    );

    for (const offsetMinutes of offsets) {
      let dueAt =
        offsetMinutes === 0
          ? now
          : new Date(input.startAt.getTime() - offsetMinutes * 60_000);
      if (offsetMinutes > 0 && policy?.quietHoursEnabled) {
        dueAt = this.shiftOutOfQuietHours(
          dueAt,
          policy.quietHoursStart,
          policy.quietHoursEnd,
          policy.quietHoursTimezone || input.timezone || 'UTC',
        );
        if (dueAt >= input.startAt) continue;
      }
      if (offsetMinutes > 0 && dueAt <= now) continue;

      const reminder = await this.prisma.appointmentReminder.upsert({
        where: {
          bookingId_offsetMinutes: {
            bookingId: input.bookingId,
            offsetMinutes,
          },
        },
        create: {
          bookingId: input.bookingId,
          organizationId: input.organizationId,
          offsetMinutes,
          reminderType: this.getReminderType(offsetMinutes),
          dueAt,
        },
        update: {
          reminderType: this.getReminderType(offsetMinutes),
          dueAt,
          status: 'pending',
          attempts: 0,
          channels: [],
          providerMessageIds: {},
          lastError: null,
          sentAt: null,
        },
      });

      if (this.queueService.isEnabled()) {
        try {
          await this.queueService.add(
            APPOINTMENT_REMINDER_QUEUE,
            APPOINTMENT_REMINDER_JOB,
            {
              reminderId: reminder.id,
              expectedDueAt: dueAt.toISOString(),
            } satisfies AppointmentReminderJobData,
            {
              delay: Math.max(0, dueAt.getTime() - Date.now()),
              jobId: appointmentReminderJobId(reminder.id, dueAt),
              attempts: 1,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.prisma.appointmentReminder.update({
            where: { id: reminder.id },
            data: {
              status: 'failed',
              lastError: `Queue publish failed: ${message}`,
            },
          });
        }
      } else {
        await this.prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: {
            status: 'failed',
            lastError:
              'Reminder queue is disabled because REDIS_URL is not configured',
          },
        });
      }
    }
  }

  async cancelBookingReminders(bookingId: string): Promise<void> {
    const reminders = await this.prisma.appointmentReminder.findMany({
      where: {
        bookingId,
        status: { in: ['pending', 'failed'] },
      },
      select: { id: true, dueAt: true },
    });

    if (reminders.length) {
      await this.prisma.appointmentReminder.updateMany({
        where: { id: { in: reminders.map((reminder) => reminder.id) } },
        data: { status: 'cancelled' },
      });
      await Promise.allSettled(
        reminders.flatMap((reminder) => [
          this.queueService.remove(APPOINTMENT_REMINDER_QUEUE, reminder.id),
          this.queueService.remove(
            APPOINTMENT_REMINDER_QUEUE,
            appointmentReminderJobId(reminder.id, reminder.dueAt),
          ),
        ]),
      );
    }
  }

  async retryDeadLetter(reminderId: string): Promise<void> {
    const dueAt = new Date();
    const reminder = await this.prisma.appointmentReminder.update({
      where: { id: reminderId },
      data: {
        dueAt,
        status: 'pending',
        attempts: 0,
        lastError: null,
      },
    });
    if (!this.queueService.isEnabled()) {
      await this.prisma.appointmentReminder.update({
        where: { id: reminderId },
        data: { status: 'failed', lastError: 'Reminder queue is disabled' },
      });
      return;
    }
    try {
      await this.queueService.add(
        APPOINTMENT_REMINDER_QUEUE,
        APPOINTMENT_REMINDER_JOB,
        {
          reminderId,
          expectedDueAt: dueAt.toISOString(),
        } satisfies AppointmentReminderJobData,
        { jobId: appointmentReminderJobId(reminder.id, dueAt), attempts: 1 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.appointmentReminder.update({
        where: { id: reminderId },
        data: {
          status: 'failed',
          lastError: `Queue publish failed: ${message}`,
        },
      });
      throw error;
    }
  }

  private getReminderOffsets(): number[] {
    return [...APPLICATION_DEFAULTS.appointments.reminderOffsetsMinutes];
  }

  private getReminderType(offsetMinutes: number): string {
    if (offsetMinutes === 0) return 'confirmation';
    if (offsetMinutes % (24 * 60) === 0) {
      return `${offsetMinutes / (24 * 60)}d_before`;
    }
    if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60}h_before`;
    return `${offsetMinutes}m_before`;
  }

  private shiftOutOfQuietHours(
    dueAt: Date,
    quietStart: string,
    quietEnd: string,
    timezone: string,
  ): Date {
    const startMinutes = this.parseTime(quietStart);
    const endMinutes = this.parseTime(quietEnd);
    let candidate = new Date(dueAt);
    for (let minute = 0; minute <= 24 * 60; minute += 1) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(candidate);
      const hour = Number(parts.find((part) => part.type === 'hour')?.value);
      const localMinute = Number(
        parts.find((part) => part.type === 'minute')?.value,
      );
      const value = hour * 60 + localMinute;
      const isQuiet =
        startMinutes === endMinutes
          ? true
          : startMinutes < endMinutes
            ? value >= startMinutes && value < endMinutes
            : value >= startMinutes || value < endMinutes;
      if (!isQuiet) return candidate;
      candidate = new Date(candidate.getTime() + 60_000);
    }
    return candidate;
  }

  private parseTime(value: string): number {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }
}
