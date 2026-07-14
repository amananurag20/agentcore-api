import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsAppAssistantConfig } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';

export interface WhatsAppOutboundResult {
  provider: 'mock' | 'meta' | 'twilio' | 'custom';
  status: 'queued' | 'sent' | 'skipped';
  providerMessageId?: string;
}

@Injectable()
export class WhatsAppOutboundService {
  private readonly logger = new Logger(WhatsAppOutboundService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
  ) {}

  async sendText(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    content: string;
  }): Promise<WhatsAppOutboundResult> {
    this.assertWhatsAppRecipient(input.to);
    const mode =
      this.configService.get<'mock' | 'live'>('WHATSAPP_OUTBOUND_MODE') ??
      'mock';

    if (mode === 'live') {
      if (input.config.provider === 'meta') {
        return this.sendMetaText(input);
      }

      if (input.config.provider === 'twilio') {
        return this.sendTwilioText(input);
      }

      throw new ServiceUnavailableException(
        `Live outbound delivery is not implemented for provider ${input.config.provider}`,
      );
    }

    return this.sendMockText(input);
  }

  private sendMockText(input: {
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

  private async sendMetaText(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    content: string;
  }): Promise<WhatsAppOutboundResult> {
    if (!input.config.accessTokenEncrypted || !input.config.phoneNumberId) {
      throw new ServiceUnavailableException(
        `Meta WhatsApp credentials are missing for config ${input.config.id}`,
      );
    }

    const accessToken = this.cryptoService.decrypt(
      input.config.accessTokenEncrypted,
    );
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${input.config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'text',
          text: {
            preview_url: false,
            body: input.content,
          },
        }),
        signal: this.providerTimeoutSignal(),
      },
    );

    const body = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(
        body.error?.message ??
          `Meta WhatsApp send failed with ${response.status}`,
      );
    }

    return {
      provider: 'meta',
      status: 'sent',
      providerMessageId: body.messages?.[0]?.id,
    };
  }

  private async sendTwilioText(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    content: string;
  }): Promise<WhatsAppOutboundResult> {
    if (
      !input.config.accessTokenEncrypted ||
      !input.config.businessAccountId ||
      !input.config.phoneNumberId
    ) {
      throw new ServiceUnavailableException(
        `Twilio WhatsApp credentials are missing for config ${input.config.id}`,
      );
    }

    const authToken = this.cryptoService.decrypt(
      input.config.accessTokenEncrypted,
    );
    const accountSid = input.config.businessAccountId;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const form = new URLSearchParams({
      From: `whatsapp:${input.config.phoneNumberId}`,
      To: input.to.startsWith('whatsapp:') ? input.to : `whatsapp:${input.to}`,
      Body: input.content,
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new Error(
        body.message ?? `Twilio WhatsApp send failed with ${response.status}`,
      );
    }

    return {
      provider: 'twilio',
      status: 'sent',
      providerMessageId: body.sid,
    };
  }

  private providerTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(
      this.configService.get<number>('WHATSAPP_PROVIDER_TIMEOUT_MS', 10_000),
    );
  }

  private assertWhatsAppRecipient(value: string) {
    const normalized = value.startsWith('whatsapp:')
      ? value.slice('whatsapp:'.length)
      : value;
    if (!/^\+?[1-9]\d{7,14}$/.test(normalized)) {
      throw new BadRequestException(
        'WhatsApp recipient must be a valid E.164 phone number',
      );
    }
  }
}
