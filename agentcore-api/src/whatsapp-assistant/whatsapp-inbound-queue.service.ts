import { Injectable } from '@nestjs/common';
import {
  WHATSAPP_INBOUND_JOB,
  WHATSAPP_INBOUND_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

export type WhatsAppInboundJobData = { messageId: string };

@Injectable()
export class WhatsAppInboundQueueService {
  constructor(private readonly queueService: QueueService) {}

  async enqueue(messageId: string) {
    return this.queueService.add<WhatsAppInboundJobData>(
      WHATSAPP_INBOUND_QUEUE,
      WHATSAPP_INBOUND_JOB,
      { messageId },
      { jobId: `message-${messageId}` },
    );
  }

  isEnabled() {
    return this.queueService.isEnabled();
  }
}
