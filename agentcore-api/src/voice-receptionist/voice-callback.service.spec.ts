import { ConfigService } from '@nestjs/config';
import { VoiceCall, VoiceReceptionistConfig } from '@prisma/client';
import { VoiceReceptionistService } from './voice-receptionist.service';

describe('VoiceReceptionistService Twilio callbacks', () => {
  const config = {
    id: 'config-1',
    organizationId: 'org-1',
    provider: 'twilio',
    status: 'active',
    name: 'Reception',
    phoneNumber: '+15551234567',
    sipDomain: null,
    webhookVerifyTokenEncrypted: null,
    apiKeyEncrypted: 'secret',
    sttProvider: null,
    sttModel: null,
    ttsProvider: 'twilio',
    ttsVoice: 'alice',
    defaultLocale: 'en-US',
    transferPhoneNumber: '+15557654321',
    voicemailEnabled: true,
    settings: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as VoiceReceptionistConfig;
  const call = {
    id: 'call-1',
    organizationId: 'org-1',
    configId: 'config-1',
    status: 'transferred',
    providerCallId: 'CA123',
    fromNumber: '+15550000000',
    toNumber: '+15551234567',
    callerName: null,
    locale: 'en-US',
    assignedAgentId: null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: null,
    durationSeconds: null,
    recordingSid: null,
    recordingUrl: null,
    recordingDurationSeconds: null,
    lastEventAt: new Date('2026-01-01T00:00:00Z'),
    summary: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as VoiceCall;

  function createService() {
    const voiceCallUpdates: unknown[] = [];
    const voiceCallUpdate = jest.fn((args: unknown) => {
      voiceCallUpdates.push(args);
      return Promise.resolve({ ...call, events: [] });
    });
    const prisma = {
      voiceReceptionistConfig: {
        findFirst: jest.fn().mockResolvedValue(config),
        findUniqueOrThrow: jest.fn().mockResolvedValue(config),
      },
      organizationProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'agent-1' }),
      },
      voiceCall: {
        findUnique: jest.fn().mockResolvedValue({ ...call, events: [] }),
        update: voiceCallUpdate,
        upsert: jest.fn().mockResolvedValue({ ...call, events: [] }),
      },
      voiceCallEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1', metadata: {} }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'event-1', metadata: {} }),
      },
    };
    const outbound = {
      hasConversationRelay: jest.fn(() => false),
      buildConversationRelayTwiml: jest.fn(
        () => '<Response><Connect/></Response>',
      ),
      buildVoicemailTwiml: jest.fn(() => '<Response><Record/></Response>'),
      buildGatherTwiml: jest.fn(() => '<Response><Gather/></Response>'),
      buildCloseTwiml: jest.fn(() => '<Response><Hangup/></Response>'),
      buildTransferTwiml: jest.fn(() => '<Response><Dial/></Response>'),
      transferCall: jest.fn().mockResolvedValue({
        provider: 'mock',
        status: 'queued',
        providerActionId: 'mock-transfer-1',
      }),
    };
    const notification = {
      notifyVoicemail: jest.fn().mockResolvedValue([{ channel: 'email' }]),
      notifyHandoff: jest.fn().mockResolvedValue([{ channel: 'email' }]),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new VoiceReceptionistService(
      audit as never,
      {} as never,
      {} as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'VOICE_WEBHOOK_SIGNATURE_REQUIRED' ? false : fallback,
        ),
      } as unknown as ConfigService,
      {} as never,
      {} as never,
      notification as never,
      outbound as never,
      prisma as never,
    );
    return { notification, outbound, service, voiceCallUpdates };
  }

  it('plays a greeting immediately when Twilio connects the call', async () => {
    const { outbound, service } = createService();

    await service.handleTwilioIncoming('config-1', {
      CallSid: 'CA123',
      From: '+15550000000',
      To: '+15551234567',
    });

    expect(outbound.buildGatherTwiml).toHaveBeenCalledWith(
      config,
      'Hello, thank you for calling. How can I help you today?',
    );
  });

  it('falls back to captured voicemail when a transfer is not answered', async () => {
    const { outbound, service, voiceCallUpdates } = createService();

    const twiml = await service.handleTwilioDial('config-1', {
      CallSid: 'CA123',
      DialCallStatus: 'no-answer',
      DialCallDuration: '20',
    });

    expect(twiml).toContain('<Record/>');
    expect(outbound.buildVoicemailTwiml).toHaveBeenCalledWith(config);
    const update = voiceCallUpdates[0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe('voicemail');
  });

  it('assigns and notifies an agent when handoff cannot connect live', async () => {
    const { notification, service, voiceCallUpdates } = createService();

    await service.requestHandoff(
      {
        sub: 'admin-1',
        email: 'admin@example.com',
        orgId: 'org-1',
        roles: ['org_admin'],
      },
      'call-1',
    );

    const update = voiceCallUpdates[0] as {
      data: { status: string; assignedAgentId: string };
    };
    expect(update.data.status).toBe('waiting_for_agent');
    expect(update.data.assignedAgentId).toBe('agent-1');
    expect(notification.notifyHandoff).toHaveBeenCalled();
  });

  it('stores recording metadata and notifies the organization once complete', async () => {
    const { notification, service, voiceCallUpdates } = createService();

    await service.handleTwilioRecording('config-1', {
      CallSid: 'CA123',
      RecordingSid: 'RE123',
      RecordingUrl: 'https://api.twilio.com/recordings/RE123',
      RecordingStatus: 'completed',
      RecordingDuration: '24',
      TranscriptionText: 'Please call me back.',
    });

    const update = voiceCallUpdates[0] as {
      data: { recordingSid: string; recordingDurationSeconds: number };
    };
    expect(update.data.recordingSid).toBe('RE123');
    expect(update.data.recordingDurationSeconds).toBe(24);
    expect(notification.notifyVoicemail).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ id: 'call-1' }),
      'https://api.twilio.com/recordings/RE123',
      'Please call me back.',
    );
  });

  it('persists terminal status and duration from Twilio lifecycle callbacks', async () => {
    const { service, voiceCallUpdates } = createService();

    await service.handleTwilioStatus('config-1', {
      CallSid: 'CA123',
      CallStatus: 'completed',
      CallDuration: '42',
    });

    const update = voiceCallUpdates[0] as {
      data: { status: string; durationSeconds: number; endedAt: Date };
    };
    expect(update.data.status).toBe('completed');
    expect(update.data.durationSeconds).toBe(42);
    expect(update.data.endedAt).toBeInstanceOf(Date);
  });
});
