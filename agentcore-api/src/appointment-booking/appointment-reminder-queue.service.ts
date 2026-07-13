import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async enqueueBookingReminders(input: {
    bookingId: string;
    organizationId: string;
    startAt: Date;
  }) {
    await this.cancelBookingReminders(input.bookingId);
    const now = new Date();
    const offsets = [0, ...this.getReminderOffsets()];

    for (const offsetMinutes of offsets) {
      const dueAt = new Date(input.startAt.getTime() - offsetMinutes * 60_000);
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

  private getReminderOffsets(): number[] {
    const raw =
      this.configService.get<string>('APPOINTMENT_REMINDER_OFFSETS_MINUTES') ??
      '1440,60';

    return raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  }

  private getReminderType(offsetMinutes: number): string {
    if (offsetMinutes === 0) return 'confirmation';
    if (offsetMinutes % (24 * 60) === 0) {
      return `${offsetMinutes / (24 * 60)}d_before`;
    }
    if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60}h_before`;
    return `${offsetMinutes}m_before`;
  }
}
