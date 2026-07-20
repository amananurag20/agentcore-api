import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WhatsAppAssistantConfig } from '@prisma/client';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';

const config = {
  id: 'config-1',
  provider: 'meta',
  accessTokenEncrypted: null,
  phoneNumberId: null,
} as WhatsAppAssistantConfig;

describe('WhatsAppOutboundService', () => {
  afterEach(() => jest.restoreAllMocks());
  it('fails closed when live Meta credentials are missing', async () => {
    const service = new WhatsAppOutboundService(
      {
        get: (key: string) =>
          key === 'WHATSAPP_OUTBOUND_MODE' ? 'live' : undefined,
      } as never,
      {} as never,
    );

    await expect(
      service.sendText({ config, to: '15551234567', content: 'Hello' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects invalid recipient numbers before delivery', async () => {
    const service = new WhatsAppOutboundService(
      { get: () => 'mock' } as never,
      {} as never,
    );

    await expect(
      service.sendText({ config, to: 'not-a-phone', content: 'Hello' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('honors a Meta 429 retry and sends a localized template', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"rate limited"}}', {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"messages":[{"id":"wamid.1"}]}', { status: 200 }),
      );
    const service = new WhatsAppOutboundService(
      {
        get: (key: string, fallback?: unknown) =>
          key === 'WHATSAPP_OUTBOUND_MODE'
            ? 'live'
            : key === 'WHATSAPP_PROVIDER_MAX_RETRIES'
              ? 2
              : fallback,
      } as never,
      { decrypt: () => 'token' } as never,
    );
    const liveConfig = {
      ...config,
      accessTokenEncrypted: 'encrypted',
      phoneNumberId: 'phone-1',
    } as WhatsAppAssistantConfig;

    await expect(
      service.sendTemplate({
        config: liveConfig,
        to: '15551234567',
        name: 'order_update',
        language: 'hi',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] },
        ],
      }),
    ).resolves.toMatchObject({ providerMessageId: 'wamid.1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rawBody = (fetchMock.mock.calls[1][1] as RequestInit).body;
    if (typeof rawBody !== 'string') throw new Error('Expected JSON body');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'template',
      template: { name: 'order_update', language: { code: 'hi' } },
    });
  });

  it('submits a template draft to the configured Meta business account', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'meta-template-1', status: 'PENDING' }),
          { status: 200 },
        ),
      );
    const service = new WhatsAppOutboundService(
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      { decrypt: () => 'management-token' } as never,
    );
    const liveConfig = {
      ...config,
      provider: 'meta',
      accessTokenEncrypted: 'encrypted',
      businessAccountId: 'waba-1',
    } as WhatsAppAssistantConfig;

    await expect(
      service.createMetaTemplate(liveConfig, {
        name: 'appointment_reminder',
        language: 'en_US',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Hello {{1}}' }],
      }),
    ).resolves.toMatchObject({ id: 'meta-template-1', status: 'PENDING' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl: unknown = fetchMock.mock.calls[0][0];
    expect(requestUrl).toBeInstanceOf(URL);
    if (!(requestUrl instanceof URL)) throw new Error('Expected URL request');
    expect(requestUrl.pathname).toContain('/waba-1/message_templates');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('uploads template sample media through Meta resumable upload', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'upload:session?sig=abc' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ h: '4::meta-handle' }), { status: 200 }),
      );
    const service = new WhatsAppOutboundService(
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      { decrypt: () => 'management-token' } as never,
    );
    const liveConfig = {
      ...config,
      provider: 'meta',
      accessTokenEncrypted: 'encrypted',
      settings: { metaAppId: '123456789' },
    } as WhatsAppAssistantConfig;

    await expect(
      service.uploadTemplateMedia(liveConfig, {
        buffer: Buffer.from('sample'),
        originalname: 'header.png',
        mimetype: 'image/png',
        size: 6,
      }),
    ).resolves.toMatchObject({ handle: '4::meta-handle' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sessionUrl: unknown = fetchMock.mock.calls[0][0];
    expect(sessionUrl).toBeInstanceOf(URL);
    if (!(sessionUrl instanceof URL)) throw new Error('Expected URL request');
    expect(sessionUrl.pathname).toContain('/123456789/uploads');
    const uploadInit = fetchMock.mock.calls[1][1];
    expect(uploadInit?.method).toBe('POST');
    expect(uploadInit?.headers).toMatchObject({
      Authorization: 'OAuth management-token',
      file_offset: '0',
    });
  });
});
