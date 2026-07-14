import { BadRequestException } from '@nestjs/common';
import { parseMetaWebhook } from './whatsapp-webhook.types';

describe('parseMetaWebhook', () => {
  it('normalizes nested Meta text and media messages', () => {
    const result = parseMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-1' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'Ada' } }],
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.text',
                    timestamp: '1710000000',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                  {
                    from: '15551234567',
                    id: 'wamid.image',
                    timestamp: '1710000001',
                    type: 'image',
                    image: {
                      id: 'media-1',
                      caption: 'Receipt',
                      mime_type: 'image/jpeg',
                      sha256: 'abc',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.phoneNumberIds).toEqual(['phone-1']);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      contactWaId: '15551234567',
      contactName: 'Ada',
      providerMessageId: 'wamid.text',
      type: 'text',
      content: 'Hello',
    });
    expect(result.messages[1]).toMatchObject({
      providerMessageId: 'wamid.image',
      type: 'image',
      content: 'Receipt',
      mediaMimeType: 'image/jpeg',
      mediaSha256: 'abc',
      metadata: { mediaId: 'media-1' },
    });
    expect(result.messages[1].mediaUrl).toBeUndefined();
  });

  it('accepts delivery-status webhooks without inventing inbound messages', () => {
    const result = parseMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.1',
                    status: 'delivered',
                    recipient_id: '15551234567',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result.messages).toEqual([]);
    expect(result.statuses).toEqual([
      expect.objectContaining({
        providerMessageId: 'wamid.1',
        status: 'delivered',
      }),
    ]);
  });

  it('rejects the old flat payload as a Meta webhook', () => {
    expect(() =>
      parseMetaWebhook({ contactWaId: '15551234567', content: 'Hello' }),
    ).toThrow(BadRequestException);
  });
});
