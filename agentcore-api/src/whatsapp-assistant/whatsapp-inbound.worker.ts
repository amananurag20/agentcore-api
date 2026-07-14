import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Worker } from 'bullmq';
import {
  WHATSAPP_INBOUND_JOB,
  WHATSAPP_INBOUND_QUEUE,
} from '../queue/queue.constants';
import { parseRedisConnection } from '../queue/redis-connection';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';
import { WhatsAppInboundJobData } from './whatsapp-inbound-queue.service';

@Injectable()
export class WhatsAppInboundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppInboundWorker.name);
  private worker: Worker<WhatsAppInboundJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly whatsAppService: WhatsAppAssistantService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) return;

    const connection: ConnectionOptions = parseRedisConnection(redisUrl);
    this.worker = new Worker<WhatsAppInboundJobData>(
      WHATSAPP_INBOUND_QUEUE,
      (job) => this.process(job),
      {
        connection,
        concurrency: this.configService.get<number>(
          'WHATSAPP_INBOUND_QUEUE_CONCURRENCY',
          5,
        ),
        prefix: this.configService.get<string>('QUEUE_PREFIX') ?? 'agentcore',
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `WhatsApp inbound job failed: ${job?.id ?? 'unknown'}`,
        error.stack,
      );
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<WhatsAppInboundJobData>) {
    if (job.name !== WHATSAPP_INBOUND_JOB) return;
    await this.whatsAppService.processInboundMessage(job.data.messageId);
  }
}
