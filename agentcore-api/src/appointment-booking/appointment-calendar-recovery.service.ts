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
  APPOINTMENT_CALENDAR_SYNC_JOB,
  APPOINTMENT_CALENDAR_SYNC_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  AppointmentCalendarService,
  AppointmentCalendarSyncJobData,
} from './appointment-calendar.service';
import { AppointmentOperationsAlertService } from './appointment-operations-alert.service';

@Injectable()
export class AppointmentCalendarRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentCalendarRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly auditService: AuditService,
    private readonly alertService: AppointmentOperationsAlertService,
    private readonly calendarService: AppointmentCalendarService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  onModuleInit() {
    if (!this.queueService.isEnabled()) return;
    void this.recover();
    const interval = this.configService.get<number>(
      'APPOINTMENT_CALENDAR_RECOVERY_INTERVAL_MS',
      60_000,
    );
    this.timer = setInterval(() => void this.recover(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    try {
      const maxAttempts = this.configService.get<number>(
        'APPOINTMENT_CALENDAR_SYNC_MAX_ATTEMPTS',
        10,
      );
      const processingTimeoutMs = this.configService.get<number>(
        'APPOINTMENT_CALENDAR_SYNC_PROCESSING_TIMEOUT_MS',
        300_000,
      );
      const processingCutoff = new Date(Date.now() - processingTimeoutMs);
      const terminalEvents =
        await this.prisma.appointmentCalendarEvent.findMany({
          where: {
            attempts: { gte: maxAttempts },
            OR: [
              { status: { in: ['pending', 'failed'] } },
              { status: 'syncing', updatedAt: { lt: processingCutoff } },
            ],
          },
          orderBy: { updatedAt: 'asc' },
          take: 500,
        });
      await Promise.all(
        terminalEvents.map((event) =>
          this.deadLetterCalendarEvent(event, maxAttempts),
        ),
      );
      await this.prisma.appointmentCalendarEvent.updateMany({
        where: {
          status: 'syncing',
          updatedAt: { lt: processingCutoff },
          attempts: { lt: maxAttempts },
        },
        data: {
          status: 'failed',
          lastError: 'Recovered after worker stopped during calendar sync',
        },
      });
      const events = await this.prisma.appointmentCalendarEvent.findMany({
        where: {
          status: { in: ['pending', 'failed'] },
          attempts: { lt: maxAttempts },
          connection: { status: { in: ['active', 'error'] } },
        },
        orderBy: { updatedAt: 'asc' },
        take: 500,
      });
      await Promise.all(
        events.map(async (event) => {
          const jobId = this.calendarService.calendarJobId(
            event.id,
            event.updatedAt,
          );
          await this.queueService
            .remove(APPOINTMENT_CALENDAR_SYNC_QUEUE, jobId)
            .catch(() => undefined);
          return this.queueService.add(
            APPOINTMENT_CALENDAR_SYNC_QUEUE,
            APPOINTMENT_CALENDAR_SYNC_JOB,
            {
              calendarEventId: event.id,
              expectedUpdatedAt: event.updatedAt.toISOString(),
            } satisfies AppointmentCalendarSyncJobData,
            { jobId },
          );
        }),
      );
    } catch (error) {
      this.logger.error('Calendar recovery scan failed', error);
    }
  }

  private async deadLetterCalendarEvent(
    event: {
      id: string;
      organizationId: string;
      bookingId: string;
      connectionId: string;
      operation: string;
      status: string;
      attempts: number;
      updatedAt: Date;
      lastError: string | null;
    },
    maxAttempts: number,
  ): Promise<void> {
    const transitioned = await this.prisma.appointmentCalendarEvent.updateMany({
      where: {
        id: event.id,
        status: event.status as 'pending' | 'syncing' | 'failed',
        attempts: { gte: maxAttempts },
        updatedAt: event.updatedAt,
      },
      data: {
        status: 'dead_letter',
        lastError:
          event.lastError ??
          `Calendar sync abandoned after ${event.attempts} attempts`,
      },
    });
    if (!transitioned.count) return;

    this.logger.error(
      `Calendar event ${event.id} moved to dead letter after ${event.attempts} attempts`,
    );
    await this.auditService.record({
      organizationId: event.organizationId,
      action: 'appointment.calendar_sync_dead_lettered',
      entityType: 'appointment_booking',
      entityId: event.bookingId,
      metadata: {
        calendarEventId: event.id,
        connectionId: event.connectionId,
        operation: event.operation,
        attempts: event.attempts,
        lastError: event.lastError,
      },
    });
    await this.alertService.deadLetter({
      event: 'appointment.calendar.dead_letter',
      organizationId: event.organizationId,
      bookingId: event.bookingId,
      recordId: event.id,
      attempts: event.attempts,
      lastError: event.lastError,
    });
  }
}
