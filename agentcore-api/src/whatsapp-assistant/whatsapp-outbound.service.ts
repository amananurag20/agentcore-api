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
  status: 'queued' | 'sent' | 'skipped' | 'sending' | 'failed';
  providerMessageId?: string;
}

export interface MetaWhatsAppTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
  rejected_reason?: string;
}

export interface MetaWhatsAppTemplateSubmission {
  id?: string;
  status?: string;
  category?: string;
}

export interface MetaTemplateMediaUpload {
  handle: string;
  filename: string;
  mimeType: string;
  size: number;
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
    return this.send(
      input,
      () =>
        this.sendMetaMessage(input.config, input.to, {
          type: 'text',
          text: { preview_url: false, body: input.content },
        }),
      () => this.sendTwilioText(input),
    );
  }

  async sendTemplate(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    name: string;
    language: string;
    components?: Record<string, unknown>[];
  }): Promise<WhatsAppOutboundResult> {
    return this.send(input, () =>
      this.sendMetaMessage(input.config, input.to, {
        type: 'template',
        template: {
          name: input.name,
          language: { policy: 'deterministic', code: input.language },
          ...(input.components?.length ? { components: input.components } : {}),
        },
      }),
    );
  }

  async sendMedia(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    type: 'image' | 'audio' | 'video' | 'document';
    mediaId?: string;
    link?: string;
    caption?: string;
    filename?: string;
  }): Promise<WhatsAppOutboundResult> {
    if (!input.mediaId && !input.link) {
      throw new BadRequestException(
        'A Meta media id or HTTPS media link is required',
      );
    }
    if (input.link) this.assertHttpsUrl(input.link);
    const media = {
      ...(input.mediaId ? { id: input.mediaId } : { link: input.link }),
      ...(input.caption && input.type !== 'audio'
        ? { caption: input.caption }
        : {}),
      ...(input.filename && input.type === 'document'
        ? { filename: input.filename }
        : {}),
    };
    return this.send(
      input,
      () =>
        this.sendMetaMessage(input.config, input.to, {
          type: input.type,
          [input.type]: media,
        }),
      input.link ? () => this.sendTwilioMedia(input) : undefined,
    );
  }

  async sendInteractive(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    interactive: Record<string, unknown>;
  }): Promise<WhatsAppOutboundResult> {
    return this.send(input, () =>
      this.sendMetaMessage(input.config, input.to, {
        type: 'interactive',
        interactive: input.interactive,
      }),
    );
  }

  async markReadAndTyping(input: {
    config: WhatsAppAssistantConfig;
    providerMessageId: string;
  }): Promise<void> {
    const mode =
      this.configService.get<'mock' | 'live'>('WHATSAPP_OUTBOUND_MODE') ??
      'mock';
    if (mode !== 'live' || input.config.provider !== 'meta') return;
    const { accessToken, phoneNumberId } = this.metaMessagingCredentials(
      input.config,
    );
    const response = await this.fetchWithRetry(
      new URL(
        `${this.graphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: input.providerMessageId,
          typing_indicator: { type: 'text' },
        }),
      },
    );
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Meta read receipt failed with ${response.status}`,
      );
    }
  }

  async listMetaTemplates(
    config: WhatsAppAssistantConfig,
  ): Promise<MetaWhatsAppTemplate[]> {
    const { accessToken, businessAccountId } =
      this.metaManagementCredentials(config);
    let url: URL | null = new URL(
      `${this.graphBaseUrl()}/${encodeURIComponent(businessAccountId)}/message_templates`,
    );
    url.searchParams.set(
      'fields',
      'id,name,language,status,category,components,rejected_reason',
    );
    url.searchParams.set('limit', '100');
    const templates: MetaWhatsAppTemplate[] = [];

    for (let page = 0; url && page < 20; page += 1) {
      this.assertGraphUrl(url);
      const response = await this.fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = (await response.json().catch(() => ({}))) as {
        data?: MetaWhatsAppTemplate[];
        paging?: { next?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new ServiceUnavailableException(
          body.error?.message ??
            `Meta template sync failed with ${response.status}`,
        );
      }
      templates.push(...(body.data ?? []));
      url = body.paging?.next ? new URL(body.paging.next) : null;
    }

    return templates;
  }

  async createMetaTemplate(
    config: WhatsAppAssistantConfig,
    input: {
      name: string;
      language: string;
      category: string;
      components: Record<string, unknown>[];
    },
  ): Promise<MetaWhatsAppTemplateSubmission> {
    if (config.provider !== 'meta') {
      throw new BadRequestException(
        'Template submission is only available for Meta configurations',
      );
    }
    const { accessToken, businessAccountId } =
      this.metaManagementCredentials(config);
    const url = new URL(
      `${this.graphBaseUrl()}/${encodeURIComponent(businessAccountId)}/message_templates`,
    );
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as
      | MetaWhatsAppTemplateSubmission
      | { error?: { message?: string; error_user_msg?: string } };
    if (!response.ok) {
      const error = 'error' in body ? body.error : undefined;
      throw new ServiceUnavailableException(
        error?.error_user_msg ??
          error?.message ??
          `Meta template submission failed with ${response.status}`,
      );
    }
    return body as MetaWhatsAppTemplateSubmission;
  }

  async uploadTemplateMedia(
    config: WhatsAppAssistantConfig,
    file: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ): Promise<MetaTemplateMediaUpload> {
    if (config.provider !== 'meta') {
      throw new BadRequestException(
        'Template media uploads are only available for Meta configurations',
      );
    }
    const settings =
      config.settings &&
      !Array.isArray(config.settings) &&
      typeof config.settings === 'object'
        ? (config.settings as Record<string, unknown>)
        : {};
    const appId =
      typeof settings.metaAppId === 'string' ? settings.metaAppId.trim() : '';
    if (!/^\d+$/.test(appId)) {
      throw new BadRequestException(
        'A numeric Meta App ID is required in the WhatsApp configuration before uploading template media',
      );
    }
    if (!config.accessTokenEncrypted) {
      throw new ServiceUnavailableException(
        `Meta access token is missing for config ${config.id}`,
      );
    }
    const accessToken = this.cryptoService.decrypt(config.accessTokenEncrypted);
    const sessionUrl = new URL(
      `${this.graphBaseUrl()}/${encodeURIComponent(appId)}/uploads`,
    );
    sessionUrl.searchParams.set('file_name', file.originalname);
    sessionUrl.searchParams.set('file_length', String(file.size));
    sessionUrl.searchParams.set('file_type', file.mimetype);
    const sessionResponse = await this.fetchWithRetry(sessionUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const session = (await sessionResponse.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!sessionResponse.ok || !session.id) {
      throw new ServiceUnavailableException(
        session.error?.message ??
          `Meta upload session failed with ${sessionResponse.status}`,
      );
    }

    const uploadUrl = new URL(`${this.graphBaseUrl()}/${session.id}`);
    this.assertGraphUrl(uploadUrl);
    const uploadResponse = await this.fetchWithRetry(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        'Content-Type': file.mimetype,
        file_offset: '0',
      },
      body: Uint8Array.from(file.buffer).buffer,
    });
    const uploaded = (await uploadResponse.json().catch(() => ({}))) as {
      h?: string;
      error?: { message?: string };
    };
    if (!uploadResponse.ok || !uploaded.h) {
      throw new ServiceUnavailableException(
        uploaded.error?.message ??
          `Meta template media upload failed with ${uploadResponse.status}`,
      );
    }
    return {
      handle: uploaded.h,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  private async send(
    input: { config: WhatsAppAssistantConfig; to: string },
    meta: () => Promise<WhatsAppOutboundResult>,
    twilio?: () => Promise<WhatsAppOutboundResult>,
  ) {
    this.assertWhatsAppRecipient(input.to);
    const mode =
      this.configService.get<'mock' | 'live'>('WHATSAPP_OUTBOUND_MODE') ??
      'mock';
    if (mode !== 'live') return this.sendMock(input.config);
    if (input.config.provider === 'meta') return meta();
    if (input.config.provider === 'twilio' && twilio) return twilio();
    throw new ServiceUnavailableException(
      `This WhatsApp message type is not implemented for provider ${input.config.provider}`,
    );
  }

  private sendMock(config: WhatsAppAssistantConfig): WhatsAppOutboundResult {
    this.logger.log(
      `WhatsApp outbound mock provider=${config.provider} config=${config.id}`,
    );
    return {
      provider: 'mock',
      status: 'queued',
      providerMessageId: `mock-${Date.now()}`,
    };
  }

  private async sendMetaMessage(
    config: WhatsAppAssistantConfig,
    to: string,
    message: Record<string, unknown>,
  ): Promise<WhatsAppOutboundResult> {
    const { accessToken, phoneNumberId } =
      this.metaMessagingCredentials(config);
    const response = await this.fetchWithRetry(
      new URL(
        `${this.graphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          ...message,
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
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
  }) {
    return this.sendTwilio(input.config, input.to, { Body: input.content });
  }

  private async sendTwilioMedia(input: {
    config: WhatsAppAssistantConfig;
    to: string;
    link?: string;
    caption?: string;
  }) {
    return this.sendTwilio(input.config, input.to, {
      ...(input.caption ? { Body: input.caption } : {}),
      MediaUrl: input.link!,
    });
  }

  private async sendTwilio(
    config: WhatsAppAssistantConfig,
    to: string,
    fields: Record<string, string>,
  ): Promise<WhatsAppOutboundResult> {
    if (
      !config.accessTokenEncrypted ||
      !config.businessAccountId ||
      !config.phoneNumberId
    ) {
      throw new ServiceUnavailableException(
        `Twilio WhatsApp credentials are missing for config ${config.id}`,
      );
    }
    const authToken = this.cryptoService.decrypt(config.accessTokenEncrypted);
    const accountSid = config.businessAccountId;
    const form = new URLSearchParams({
      From: `whatsapp:${config.phoneNumberId}`,
      To: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      ...fields,
    });
    const response = await this.fetchWithRetry(
      new URL(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body.message ?? `Twilio WhatsApp send failed with ${response.status}`,
      );
    }
    return { provider: 'twilio', status: 'sent', providerMessageId: body.sid };
  }

  private async fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
    const maxRetries = this.configService.get<number>(
      'WHATSAPP_PROVIDER_MAX_RETRIES',
      2,
    );
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(
            this.configService.get<number>(
              'WHATSAPP_PROVIDER_TIMEOUT_MS',
              10_000,
            ),
          ),
        });
        if (
          attempt < maxRetries &&
          [408, 425, 429, 500, 502, 503, 504].includes(response.status)
        ) {
          await this.sleep(this.retryDelay(response, attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
      }
    }
    throw new ServiceUnavailableException(
      `WhatsApp provider request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private retryDelay(response: Response, attempt: number) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
      }
      const dateDelay = Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(dateDelay)) {
        return Math.min(Math.max(dateDelay, 0), 30_000);
      }
    }
    return 250 * 2 ** attempt;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private metaMessagingCredentials(config: WhatsAppAssistantConfig) {
    if (!config.accessTokenEncrypted || !config.phoneNumberId) {
      throw new ServiceUnavailableException(
        `Meta WhatsApp credentials are missing for config ${config.id}`,
      );
    }
    return {
      accessToken: this.cryptoService.decrypt(config.accessTokenEncrypted),
      phoneNumberId: config.phoneNumberId,
    };
  }

  private metaManagementCredentials(config: WhatsAppAssistantConfig) {
    if (!config.accessTokenEncrypted || !config.businessAccountId) {
      throw new ServiceUnavailableException(
        `Meta template-management credentials are missing for config ${config.id}`,
      );
    }
    return {
      accessToken: this.cryptoService.decrypt(config.accessTokenEncrypted),
      businessAccountId: config.businessAccountId,
    };
  }

  private graphBaseUrl() {
    const version = this.configService.get<string>(
      'WHATSAPP_GRAPH_API_VERSION',
      'v20.0',
    );
    return `https://graph.facebook.com/${version}`;
  }

  private assertGraphUrl(url: URL) {
    if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
      throw new ServiceUnavailableException(
        'Meta returned an invalid paging URL',
      );
    }
  }

  private assertHttpsUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Outbound media link is invalid');
    }
    if (url.protocol !== 'https:') {
      throw new BadRequestException('Outbound media links must use HTTPS');
    }
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
