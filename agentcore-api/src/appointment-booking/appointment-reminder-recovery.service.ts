import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  APPOINTMENT_REMINDER_JOB,
  APPOINTMENT_REMINDER_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  appointmentReminderJobId,
  AppointmentReminderJobData,
} from './appointment-reminder-queue.service';

@Injectable()
export class AppointmentReminderRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentReminderRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  onModuleInit() {
    if (!this.queueService.isEnabled()) return;
    void this.recover();
    const interval = this.configService.get<number>(
      'APPOINTMENT_REMINDER_RECOVERY_INTERVAL_MS',
      60_000,
    );
    this.timer = setInterval(() => void this.recover(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    const maxAttempts = this.configService.get<number>(
      'APPOINTMENT_REMINDER_MAX_ATTEMPTS',
      10,
    );
    try {
      const reminders = await this.prisma.appointmentReminder.findMany({
        where: {
          status: { in: ['pending', 'failed'] },
          attempts: { lt: maxAttempts },
          booking: { status: { in: ['pending', 'confirmed'] } },
        },
        orderBy: { dueAt: 'asc' },
        take: 500,
      });
      await Promise.all(
        reminders.map(async (reminder) => {
          const jobId = appointmentReminderJobId(reminder.id, reminder.dueAt);
          await this.queueService
            .remove(APPOINTMENT_REMINDER_QUEUE, jobId)
            .catch(() => undefined);
          return this.queueService.add(
            APPOINTMENT_REMINDER_QUEUE,
            APPOINTMENT_REMINDER_JOB,
            {
              reminderId: reminder.id,
              expectedDueAt: reminder.dueAt.toISOString(),
            } satisfies AppointmentReminderJobData,
            {
              delay: Math.max(0, reminder.dueAt.getTime() - Date.now()),
              jobId,
            },
          );
        }),
      );
    } catch (error) {
      this.logger.error('Appointment reminder recovery scan failed', error);
    }
  }
}
