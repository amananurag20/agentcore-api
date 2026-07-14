import { ForbiddenException } from '@nestjs/common';
import { WhatsAppAssistantConfig } from '@prisma/client';
import { createHmac } from 'crypto';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';

function createService(prisma: Record<string, unknown> = {}) {
  return new WhatsAppAssistantService(
    {} as never,
    {} as never,
    { answerWithContext: jest.fn() } as never,
    { decrypt: () => 'app-secret' } as never,
    { search: jest.fn() } as never,
    { sendText: jest.fn() } as never,
    prisma as never,
    { enqueue: jest.fn(), isEnabled: () => true } as never,
    { get: () => 'test' } as never,
  );
}

const signedConfig = {
  id: 'config-1',
  appSecretEncrypted: 'encrypted',
} as WhatsAppAssistantConfig;

describe('WhatsAppAssistantService hardening', () => {
  it('accepts only an exact X-Hub-Signature-256 HMAC', () => {
    const service = createService() as unknown as {
      assertWebhookSignature(
        config: WhatsAppAssistantConfig,
        rawBody?: Buffer,
        headers?: Record<string, string>,
      ): void;
    };
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = createHmac('sha256', 'app-secret')
      .update(rawBody)
      .digest('hex');

    expect(() =>
      service.assertWebhookSignature(signedConfig, rawBody, {
        'x-hub-signature-256': `sha256=${signature}`,
      }),
    ).not.toThrow();
    expect(() =>
      service.assertWebhookSignature(signedConfig, rawBody, {
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      }),
    ).toThrow(ForbiddenException);
  });

  it('marks assigned inbound messages processed without invoking AI', async () => {
    type UpdateMessage = (input: {
      where: { id: string };
      data: { processingError?: string | null };
    }) => Promise<unknown>;
    let updateInput: Parameters<UpdateMessage>[0] | undefined;
    const updateImplementation: UpdateMessage = (input) => {
      updateInput = input;
      return Promise.resolve({});
    };
    const update = jest.fn(updateImplementation);
    const service = createService({
      whatsAppMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'message-1',
          direction: 'inbound',
          processedAt: null,
          conversation: {
            id: 'conversation-1',
            status: 'open',
            assignedAgentId: 'agent-1',
            config: signedConfig,
          },
        }),
        update,
      },
    });

    await service.processInboundMessage('message-1');

    expect(update).toHaveBeenCalled();
    expect(updateInput?.where).toEqual({ id: 'message-1' });
    expect(updateInput?.data.processingError).toBeNull();
  });
});
