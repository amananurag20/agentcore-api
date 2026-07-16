import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { WhatsAppAssistantWebhookController } from './whatsapp-assistant.controller';

describe('WhatsAppAssistantWebhookController routes', () => {
  it('uses the same Meta callback path for verification and event delivery', () => {
    const prototype = WhatsAppAssistantWebhookController.prototype;
    const verifyHandler = Object.getOwnPropertyDescriptor(
      prototype,
      'verifyWebhook',
    )?.value as object;
    const inboundHandler = Object.getOwnPropertyDescriptor(
      prototype,
      'handleInboundWebhook',
    )?.value as object;

    expect(Reflect.getMetadata(PATH_METADATA, verifyHandler)).toBe(':configId');
    expect(Reflect.getMetadata(METHOD_METADATA, verifyHandler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, inboundHandler)).toEqual([
      ':configId',
      ':configId/inbound',
    ]);
    expect(Reflect.getMetadata(METHOD_METADATA, inboundHandler)).toBe(
      RequestMethod.POST,
    );
  });
});
