import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Injectable()
export class AppointmentCalendarRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentCalendarRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
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
      const events = await this.prisma.appointmentCalendarEvent.findMany({
        where: {
          status: { in: ['pending', 'failed'] },
          attempts: { lt: 10 },
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
}
