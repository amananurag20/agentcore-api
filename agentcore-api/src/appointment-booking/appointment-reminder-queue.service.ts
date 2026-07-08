import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APPOINTMENT_REMINDER_JOB,
  APPOINTMENT_REMINDER_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

export type AppointmentReminderJobData = {
  bookingId: string;
  organizationId: string;
  reminderType: 'confirmation' | 'day_before' | 'hour_before';
};

@Injectable()
export class AppointmentReminderQueueService {
  constructor(
    private readonly configService: ConfigService,
    private readonly queueService: QueueService,
  ) {}

  async enqueueBookingReminders(input: {
    bookingId: string;
    organizationId: string;
    startAt: Date;
  }) {
    if (!this.queueService.isEnabled()) {
      return;
    }

    await this.queueService.add(
      APPOINTMENT_REMINDER_QUEUE,
      APPOINTMENT_REMINDER_JOB,
      {
        bookingId: input.bookingId,
        organizationId: input.organizationId,
        reminderType: 'confirmation',
      } satisfies AppointmentReminderJobData,
      {
        jobId: `${input.bookingId}:confirmation`,
      },
    );

    await Promise.all(
      this.getReminderOffsets().map((offsetMinutes) => {
        const reminderAt = new Date(
          input.startAt.getTime() - offsetMinutes * 60_000,
        );
        const delay = Math.max(0, reminderAt.getTime() - Date.now());
        const reminderType =
          offsetMinutes >= 24 * 60 ? 'day_before' : 'hour_before';

        return this.queueService.add(
          APPOINTMENT_REMINDER_QUEUE,
          APPOINTMENT_REMINDER_JOB,
          {
            bookingId: input.bookingId,
            organizationId: input.organizationId,
            reminderType,
          } satisfies AppointmentReminderJobData,
          {
            delay,
            jobId: `${input.bookingId}:${reminderType}`,
          },
        );
      }),
    );
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
}
