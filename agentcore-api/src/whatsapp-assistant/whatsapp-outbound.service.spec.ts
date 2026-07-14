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
});
