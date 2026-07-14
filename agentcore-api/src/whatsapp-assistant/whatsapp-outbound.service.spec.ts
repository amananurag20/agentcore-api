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
});
