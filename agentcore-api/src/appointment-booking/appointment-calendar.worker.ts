import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Worker } from 'bullmq';
import {
  APPOINTMENT_CALENDAR_SYNC_JOB,
  APPOINTMENT_CALENDAR_SYNC_QUEUE,
} from '../queue/queue.constants';
import { parseRedisConnection } from '../queue/redis-connection';
import {
  AppointmentCalendarService,
  AppointmentCalendarSyncJobData,
} from './appointment-calendar.service';

@Injectable()
export class AppointmentCalendarWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentCalendarWorker.name);
  private worker?: Worker<AppointmentCalendarSyncJobData>;

  constructor(
    private readonly calendarService: AppointmentCalendarService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) return;
    const connection: ConnectionOptions = parseRedisConnection(redisUrl);
    this.worker = new Worker<AppointmentCalendarSyncJobData>(
      APPOINTMENT_CALENDAR_SYNC_QUEUE,
      (job) => this.process(job),
      {
        connection,
        concurrency: this.configService.get<number>(
          'APPOINTMENT_CALENDAR_SYNC_CONCURRENCY',
          5,
        ),
        prefix: this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore',
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Calendar sync job failed: ${job?.id ?? 'unknown'}`,
        error.stack,
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<AppointmentCalendarSyncJobData>) {
    if (job.name !== APPOINTMENT_CALENDAR_SYNC_JOB) return;
    await this.calendarService.processCalendarEvent(job.data);
  }
}
