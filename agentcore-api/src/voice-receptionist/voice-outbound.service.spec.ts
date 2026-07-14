import { ConfigService } from '@nestjs/config';
import { VoiceReceptionistConfig } from '@prisma/client';
import { VoiceOutboundService } from './voice-outbound.service';

describe('VoiceOutboundService TwiML', () => {
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
    ttsVoice: 'alloy',
    defaultLocale: 'en',
    transferPhoneNumber: '+15557654321',
    voicemailEnabled: true,
    settings: { voicemailMaxLengthSeconds: 90 },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as VoiceReceptionistConfig;

  const service = new VoiceOutboundService(
    {
      get: jest.fn((key: string) =>
        key === 'VOICE_WEBHOOK_PUBLIC_BASE_URL'
          ? 'https://voice.example.com'
          : undefined,
      ),
    } as unknown as ConfigService,
    {} as never,
  );

  it('plays the configured greeting voice and continues into Gather', () => {
    const twiml = service.buildGatherTwiml(config, 'Welcome & hello');

    expect(twiml).toContain('<Gather input="speech dtmf"');
    expect(twiml).toContain('/config-1/twilio/gather');
    expect(twiml).toContain('voice="Polly.Joanna"');
    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('Welcome &amp; hello');
  });

  it('adds a transfer result callback and explicit voicemail capture callbacks', () => {
    const transfer = service.buildTransferTwiml(config, '+15550001111');
    const voicemail = service.buildVoicemailTwiml(config);

    expect(transfer).toContain('answerOnBridge="true"');
    expect(transfer).toContain('/config-1/twilio/dial');
    expect(voicemail).toContain('<Record maxLength="90"');
    expect(voicemail).toContain('recordingStatusCallback=');
    expect(voicemail).toContain('transcribe="true"');
    expect(voicemail).toContain('/config-1/twilio/recording');
  });

  it('hangs up explicitly after the closing prompt', () => {
    expect(service.buildCloseTwiml(config, 'Goodbye')).toContain(
      '<Say voice="Polly.Joanna" language="en-US">Goodbye</Say><Hangup/>',
    );
  });
});
