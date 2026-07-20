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
  authorizeConversationRelay(
    configId: string,
    relayToken: string | undefined,
    connectionId: string,
  ): Promise<{ config: VoiceReceptionistConfig; expectedCallSid: string }>;
  createConversationRelayTicket(
    config: VoiceReceptionistConfig,
    callSid: string,
  ): Promise<string>;
  createVoiceEvent(args: {
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  evaluateBusinessHours(config: VoiceReceptionistConfig): { isOpen: boolean };
  assertWebhookSignature(
    config: VoiceReceptionistConfig,
    input: VoiceWebhookEventDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): void;
  assertTwilioCallbackSignature(
    config: VoiceReceptionistConfig,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): void;
  buildConversationQuestion(
    call: { events: Array<{ role: string; type: string; content: string }> },
    currentMessage: string,
  ): string;
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

  function createService(
    values: Record<string, unknown> = {},
    onEventPersist?: (data: Record<string, unknown>) => void,
  ) {
    const configService = {
      get: jest.fn(
        (key: string, fallback?: unknown) => values[key] ?? fallback,
      ),
    } as unknown as ConfigService;
    const cryptoService = {
      decrypt: jest.fn((value: string) =>
        value.startsWith('encrypted:')
          ? value.slice('encrypted:'.length)
          : secret,
      ),
      encrypt: jest.fn((value: string) => `encrypted:${value}`),
    };
    const outboundService = {
      getConversationRelayUrl: jest.fn(
        () =>
          'wss://voice.example.com/api/v1/voice-receptionist/stream/config-1',
      ),
    };
    const prisma = {
      voiceReceptionistConfig: {
        findFirst: jest.fn().mockResolvedValue(baseConfig),
      },
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'product-1' }),
      },
      voiceRelayTicket: {
        upsert: jest.fn().mockResolvedValue({ id: 'ticket-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      voiceCallEvent: {
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          onEventPersist?.(args.data);
          return Promise.resolve({ id: 'event-1', ...args.data });
        }),
      },
    };
    return new VoiceReceptionistService(
      {} as never,
      {} as never,
      {} as never,
      configService,
      cryptoService as never,
      {} as never,
      {} as never,
      outboundService as never,
      prisma as never,
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

  it('validates Twilio form callbacks against the raw signed parameters', () => {
    const service = createService({
      VOICE_WEBHOOK_SIGNATURE_REQUIRED: true,
      VOICE_WEBHOOK_PUBLIC_BASE_URL: 'https://voice.example.com',
    });
    const path = '/api/v1/voice-receptionist/webhook/config-1/twilio/status';
    const rawBody = Buffer.from('CallSid=CA123&CallStatus=completed');
    const signed =
      `https://voice.example.com${path}` + 'CallSidCA123CallStatuscompleted';
    const signature = createHmac('sha1', secret)
      .update(signed)
      .digest('base64');

    expect(() =>
      service.assertTwilioCallbackSignature(
        baseConfig,
        rawBody,
        { 'x-twilio-signature': signature },
        { originalUrl: path },
      ),
    ).not.toThrow();
  });

  it('requires a per-call relay ticket and binds it to the expected CallSid', async () => {
    const service = createService({
      AI_CONFIG_ENCRYPTION_KEY: 'x'.repeat(32),
    });
    await expect(
      service.authorizeConversationRelay('config-1', undefined, 'socket-1'),
    ).rejects.toThrow(ForbiddenException);

    const ticket = await service.createConversationRelayTicket(
      baseConfig,
      'CA123',
    );
    await expect(
      service.authorizeConversationRelay('config-1', ticket, 'socket-1'),
    ).resolves.toMatchObject({
      config: baseConfig,
      expectedCallSid: 'CA123',
    });
  });

  it('includes recent caller and receptionist turns in follow-up questions', () => {
    const service = createService();
    const question = service.buildConversationQuestion(
      {
        events: [
          {
            role: 'caller',
            type: 'transcript',
            content: 'What are your hours?',
          },
          {
            role: 'assistant',
            type: 'assistant_response',
            content: 'We open at nine.',
          },
        ],
      },
      'What about Saturday?',
    );

    expect(question).toContain('Caller: What are your hours?');
    expect(question).toContain('Receptionist: We open at nine.');
    expect(question).toContain('Caller: What about Saturday?');
  });

  it('encrypts caller and assistant transcript content before persistence', async () => {
    let persisted: Record<string, unknown> | undefined;
    const service = createService({}, (data) => {
      persisted = data;
    });

    const returned = await service.createVoiceEvent({
      data: {
        organizationId: 'org-1',
        callId: 'call-1',
        type: 'transcript',
        role: 'caller',
        content: 'My account number is 1234',
      },
    });

    expect(persisted).toMatchObject({
      content: null,
      contentEncrypted: 'encrypted:My account number is 1234',
    });
    expect(returned.content).toBe('My account number is 1234');
  });
});
