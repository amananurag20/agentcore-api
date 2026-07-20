import { BadRequestException } from '@nestjs/common';
import { parseMetaWebhook, parseTwilioWebhook } from './whatsapp-webhook.types';

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

  it('normalizes button, list, Flow, reaction, and shared-contact replies', () => {
    const result = parseMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-1' },
                messages: [
                  {
                    from: '15551234567',
                    id: 'button-1',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'sales', title: 'Sales' },
                    },
                  },
                  {
                    from: '15551234567',
                    id: 'list-1',
                    type: 'interactive',
                    interactive: {
                      type: 'list_reply',
                      list_reply: {
                        id: 'support',
                        title: 'Support',
                        description: 'Technical help',
                      },
                    },
                  },
                  {
                    from: '15551234567',
                    id: 'flow-1',
                    type: 'interactive',
                    interactive: {
                      type: 'nfm_reply',
                      nfm_reply: {
                        name: 'flow',
                        body: 'Submitted',
                        response_json: '{"appointment":"Monday"}',
                      },
                    },
                  },
                  {
                    from: '15551234567',
                    id: 'reaction-1',
                    type: 'reaction',
                    reaction: { message_id: 'wamid.original', emoji: '👍' },
                  },
                  {
                    from: '15551234567',
                    id: 'contact-1',
                    type: 'contacts',
                    contacts: [
                      {
                        name: { formatted_name: 'Grace Hopper' },
                        phones: [{ phone: '+15550001111' }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.messages.map((message) => message.type)).toEqual([
      'interactive',
      'interactive',
      'interactive',
      'reaction',
      'contact',
    ]);
    expect(result.messages[0]).toMatchObject({
      content: 'Sales',
      metadata: { replyId: 'sales', interactiveType: 'button_reply' },
    });
    expect(result.messages[1].content).toBe('Support — Technical help');
    expect(result.messages[2].content).toContain('appointment');
    expect(result.messages[3].content).toContain('👍');
    expect(result.messages[4].content).toContain('Grace Hopper');
  });

  it('rejects the old flat payload as a Meta webhook', () => {
    expect(() =>
      parseMetaWebhook({ contactWaId: '15551234567', content: 'Hello' }),
    ).toThrow(BadRequestException);
  });
});

describe('parseTwilioWebhook', () => {
  it('normalizes Twilio form-encoded inbound WhatsApp messages', () => {
    expect(
      parseTwilioWebhook({
        MessageSid: 'SM123',
        From: 'whatsapp:+15551234567',
        To: 'whatsapp:+15557654321',
        Body: 'Hello from Twilio',
        ProfileName: 'Ada',
      }).messages[0],
    ).toMatchObject({
      contactWaId: '15551234567',
      providerMessageId: 'SM123',
      type: 'text',
      content: 'Hello from Twilio',
    });
  });

  it('normalizes Twilio delivery callbacks without creating inbound messages', () => {
    const result = parseTwilioWebhook({
      MessageSid: 'SM123',
      From: 'whatsapp:+15557654321',
      To: 'whatsapp:+15551234567',
      MessageStatus: 'delivered',
    });
    expect(result.messages).toEqual([]);
    expect(result.statuses[0]).toMatchObject({
      providerMessageId: 'SM123',
      status: 'delivered',
      phoneNumberId: '15557654321',
    });
  });
});
