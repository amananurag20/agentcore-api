import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppAssistantConfig } from '@prisma/client';

export interface WhatsAppOutboundResult {
  provider: 'mock' | 'meta' | 'twilio' | 'custom';
  status: 'queued' | 'sent' | 'skipped';
  providerMessageId?: string;
}

@Injectable()
export class WhatsAppOutboundService {
  private readonly logger = new Logger(WhatsAppOutboundService.name);

  sendText(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    content: string;
  }): WhatsAppOutboundResult {
    this.logger.log(
      [
        'WhatsApp outbound mock',
        `provider=${input.config.provider}`,
        `config=${input.config.id}`,
        `to=${input.to}`,
      ].join(' '),
    );

    return {
      provider: 'mock',
      status: 'queued',
      providerMessageId: `mock-${Date.now()}`,
    };
  }
}
