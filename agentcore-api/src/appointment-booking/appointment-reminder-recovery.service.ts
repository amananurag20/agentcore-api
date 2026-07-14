import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
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
    private readonly auditService: AuditService,
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
      const now = new Date();
      const processingTimeoutMs = this.configService.get<number>(
        'APPOINTMENT_REMINDER_PROCESSING_TIMEOUT_MS',
        300_000,
      );
      const processingCutoff = new Date(now.getTime() - processingTimeoutMs);
      const terminalReminders = await this.prisma.appointmentReminder.findMany({
        where: {
          attempts: { gte: maxAttempts },
          OR: [
            { status: { in: ['pending', 'failed'] } },
            { status: 'processing', updatedAt: { lt: processingCutoff } },
          ],
        },
        orderBy: { updatedAt: 'asc' },
        take: 500,
      });
      await Promise.all(
        terminalReminders.map((reminder) =>
          this.deadLetterReminder(reminder, maxAttempts),
        ),
      );
      await this.prisma.appointmentReminder.updateMany({
        where: {
          status: 'processing',
          updatedAt: { lt: processingCutoff },
          attempts: { lt: maxAttempts },
        },
        data: {
          status: 'failed',
          lastError: 'Recovered after worker stopped during delivery',
        },
      });
      const reminders = await this.prisma.appointmentReminder.findMany({
        where: {
          status: { in: ['pending', 'failed'] },
          attempts: { lt: maxAttempts },
          booking: {
            status: { in: ['pending', 'confirmed'] },
            startAt: { gt: now },
          },
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
              attempts: 1,
            },
          );
        }),
      );
    } catch (error) {
      this.logger.error('Appointment reminder recovery scan failed', error);
    }
  }

  private async deadLetterReminder(
    reminder: {
      id: string;
      organizationId: string;
      bookingId: string;
      status: string;
      attempts: number;
      updatedAt: Date;
      lastError: string | null;
    },
    maxAttempts: number,
  ): Promise<void> {
    const transitioned = await this.prisma.appointmentReminder.updateMany({
      where: {
        id: reminder.id,
        status: reminder.status as 'pending' | 'processing' | 'failed',
        attempts: { gte: maxAttempts },
        updatedAt: reminder.updatedAt,
      },
      data: {
        status: 'dead_letter',
        lastError:
          reminder.lastError ??
          `Reminder abandoned after ${reminder.attempts} attempts`,
      },
    });
    if (!transitioned.count) return;

    this.logger.error(
      `Appointment reminder ${reminder.id} moved to dead letter after ${reminder.attempts} attempts`,
    );
    await this.auditService.record({
      organizationId: reminder.organizationId,
      action: 'appointment.reminder_dead_lettered',
      entityType: 'appointment_booking',
      entityId: reminder.bookingId,
      metadata: {
        reminderId: reminder.id,
        attempts: reminder.attempts,
        lastError: reminder.lastError,
      },
    });
  }
}
