import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceReceptionistConfig } from '@prisma/client';
import { createHmac } from 'crypto';
import {
  VoiceCallEventTypeDto,
  VoiceWebhookEventDto,
} from './dto/voice-receptionist.dto';
import { VoiceReceptionistService } from './voice-receptionist.service';

type TestableVoiceService = {
  evaluateBusinessHours(config: VoiceReceptionistConfig): { isOpen: boolean };
  assertWebhookSignature(
    config: VoiceReceptionistConfig,
    input: VoiceWebhookEventDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): void;
};

describe('VoiceReceptionistService hardening', () => {
  const secret = 'twilio-auth-token';
  const baseConfig = {
    id: 'config-1',
    organizationId: 'org-1',
    provider: 'twilio',
    status: 'active',
    name: 'Reception',
    phoneNumber: '+15551234567',
    sipDomain: null,
    webhookVerifyTokenEncrypted: null,
    apiKeyEncrypted: 'encrypted-secret',
    sttProvider: null,
    sttModel: null,
    ttsProvider: null,
    ttsVoice: null,
    defaultLocale: 'en',
    transferPhoneNumber: '+15557654321',
    voicemailEnabled: true,
    settings: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as VoiceReceptionistConfig;

  function createService(values: Record<string, unknown> = {}) {
    const configService = {
      get: jest.fn(
        (key: string, fallback?: unknown) => values[key] ?? fallback,
      ),
    } as unknown as ConfigService;
    const cryptoService = { decrypt: jest.fn(() => secret) };
    return new VoiceReceptionistService(
      {} as never,
      {} as never,
      {} as never,
      configService,
      cryptoService as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableVoiceService;
  }

  afterEach(() => jest.useRealTimers());

  it('evaluates business hours in the configured timezone and observes holidays', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-14T04:00:00Z'));
    const service = createService();
    const config = {
      ...baseConfig,
      settings: {
        businessHours: {
          enabled: true,
          timezone: 'Asia/Kolkata',
          days: [2],
          startTime: '09:00',
          endTime: '18:00',
        },
      },
    } as VoiceReceptionistConfig;

    expect(service.evaluateBusinessHours(config)).toEqual({ isOpen: true });
    config.settings = {
      businessHours: {
        ...(config.settings as Record<string, Record<string, unknown>>)
          .businessHours,
        holidays: ['2026-07-14'],
      },
    };
    expect(service.evaluateBusinessHours(config)).toEqual({ isOpen: false });
  });

  it('fails closed when a required webhook signature is absent', () => {
    const service = createService({ VOICE_WEBHOOK_SIGNATURE_REQUIRED: true });
    expect(() =>
      service.assertWebhookSignature(
        baseConfig,
        {
          providerCallId: 'CA1',
          eventType: VoiceCallEventTypeDto.call_started,
        },
        Buffer.from('{}'),
        {},
      ),
    ).toThrow(ForbiddenException);
  });

  it('accepts a valid Twilio signature for the reconstructed public URL', () => {
    const service = createService({
      VOICE_WEBHOOK_SIGNATURE_REQUIRED: true,
      VOICE_WEBHOOK_PUBLIC_BASE_URL: 'https://voice.example.com',
    });
    const input = {
      providerCallId: 'CA123',
      eventType: VoiceCallEventTypeDto.call_started,
    };
    const path = '/api/v1/voice-receptionist/webhook/config-1/events';
    const payload = `https://voice.example.com${path}eventTypecall_startedproviderCallIdCA123`;
    const signature = createHmac('sha1', secret)
      .update(payload)
      .digest('base64');

    expect(() =>
      service.assertWebhookSignature(
        baseConfig,
        input,
        Buffer.from('{}'),
        { 'x-twilio-signature': signature },
        { originalUrl: path },
      ),
    ).not.toThrow();
  });
});
