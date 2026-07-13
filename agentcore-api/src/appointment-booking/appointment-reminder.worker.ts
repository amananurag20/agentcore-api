import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Worker } from 'bullmq';
import {
  APPOINTMENT_REMINDER_JOB,
  APPOINTMENT_REMINDER_QUEUE,
} from '../queue/queue.constants';
import { parseRedisConnection } from '../queue/redis-connection';
import { AppointmentReminderJobData } from './appointment-reminder-queue.service';
import { AppointmentReminderService } from './appointment-reminder.service';

@Injectable()
export class AppointmentReminderWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentReminderWorker.name);
  private connection: ConnectionOptions | null = null;
  private worker: Worker<AppointmentReminderJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly reminderService: AppointmentReminderService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      return;
    }

    this.connection = parseRedisConnection(redisUrl);
    this.worker = new Worker<AppointmentReminderJobData>(
      APPOINTMENT_REMINDER_QUEUE,
      (job) => this.process(job),
      {
        connection: this.connection,
        concurrency:
          this.configService.get<number>(
            'APPOINTMENT_REMINDER_QUEUE_CONCURRENCY',
          ) ?? 5,
        prefix: this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore',
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Appointment reminder job failed: ${job?.id ?? 'unknown'}`,
        error.stack,
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<AppointmentReminderJobData>) {
    if (job.name !== APPOINTMENT_REMINDER_JOB) {
      return;
    }

    await this.reminderService.processReminder(job.data);
    this.logger.log(`Processed appointment reminder ${job.data.reminderId}`);
  }
}
