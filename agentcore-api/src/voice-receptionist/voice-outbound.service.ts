import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VoiceReceptionistConfig } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';

export type VoiceProviderActionResult = {
  provider: 'mock' | 'twilio' | 'sip' | 'custom';
  status: 'queued' | 'sent' | 'failed';
  providerActionId: string;
  error?: string;
};

@Injectable()
export class VoiceOutboundService {
  private readonly logger = new Logger(VoiceOutboundService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
  ) {}

  async speakText(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    content: string;
  }): Promise<VoiceProviderActionResult> {
    if (this.shouldUseLiveTwilio(input.config)) {
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.buildGatherTwiml(input.config, input.content),
        actionPrefix: 'twilio-tts',
      });
    }

    return this.mockSpeakText(input);
  }

  async hangupCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    content: string;
  }): Promise<VoiceProviderActionResult> {
    if (this.shouldUseLiveTwilio(input.config)) {
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.buildCloseTwiml(input.config, input.content),
        actionPrefix: 'twilio-hangup',
      });
    }
    return this.mockSpeakText(input);
  }

  async interruptCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
  }): Promise<VoiceProviderActionResult> {
    if (this.shouldUseLiveTwilio(input.config)) {
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.buildGatherTwiml(input.config, ''),
        actionPrefix: 'twilio-interrupt',
      });
    }

    return {
      provider: 'mock',
      status: 'queued',
      providerActionId: `mock-interrupt-${Date.now()}`,
    };
  }

  async transferCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    transferTo?: string | null;
  }): Promise<VoiceProviderActionResult> {
    if (!input.transferTo) {
      throw new BadRequestException('A transfer phone number is required');
    }
    if (this.shouldUseLiveTwilio(input.config) && input.transferTo) {
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.buildTransferTwiml(input.config, input.transferTo),
        actionPrefix: 'twilio-transfer',
      });
    }

    return this.mockTransferCall(input);
  }

  async sendToVoicemail(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
  }): Promise<VoiceProviderActionResult> {
    if (this.shouldUseLiveTwilio(input.config)) {
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.buildVoicemailTwiml(input.config),
        actionPrefix: 'twilio-voicemail',
      });
    }

    return this.mockSendToVoicemail(input);
  }

  private mockSpeakText(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    content: string;
  }): VoiceProviderActionResult {
    const providerActionId = `mock-tts-${Date.now()}`;
    this.logger.log(
      JSON.stringify({
        event: 'voice.mock_speak_text',
        configId: input.config.id,
        providerCallId: input.providerCallId,
        providerActionId,
        content: input.content,
      }),
    );

    return { provider: 'mock', status: 'queued', providerActionId };
  }

  private mockTransferCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    transferTo?: string | null;
  }): VoiceProviderActionResult {
    const providerActionId = `mock-transfer-${Date.now()}`;
    this.logger.log(
      JSON.stringify({
        event: 'voice.mock_transfer_call',
        configId: input.config.id,
        providerCallId: input.providerCallId,
        transferTo: input.transferTo,
        providerActionId,
      }),
    );

    return { provider: 'mock', status: 'queued', providerActionId };
  }

  private mockSendToVoicemail(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
  }): VoiceProviderActionResult {
    const providerActionId = `mock-voicemail-${Date.now()}`;
    this.logger.log(
      JSON.stringify({
        event: 'voice.mock_send_to_voicemail',
        configId: input.config.id,
        providerCallId: input.providerCallId,
        providerActionId,
      }),
    );

    return { provider: 'mock', status: 'queued', providerActionId };
  }

  private shouldUseLiveTwilio(config: VoiceReceptionistConfig): boolean {
    return (
      (this.configService.get<'mock' | 'live'>('VOICE_OUTBOUND_MODE') ??
        'mock') === 'live' && config.provider === 'twilio'
    );
  }

  private async updateTwilioCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
    twiml: string;
    actionPrefix: string;
  }): Promise<VoiceProviderActionResult> {
    const accountSid = this.getTwilioAccountSid(input.config);
    const authToken = input.config.apiKeyEncrypted
      ? this.cryptoService.decrypt(input.config.apiKeyEncrypted)
      : undefined;

    if (!accountSid || !authToken || !input.providerCallId) {
      throw new ServiceUnavailableException(
        `Twilio Voice credentials or call id are missing for config=${input.config.id}`,
      );
    }

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const form = new URLSearchParams({ Twiml: input.twiml });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${input.providerCallId}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(
          this.configService.get<number>('VOICE_PROVIDER_TIMEOUT_MS', 5_000),
        ),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new Error(
        body.message ?? `Twilio Voice action failed with ${response.status}`,
      );
    }

    return {
      provider: 'twilio',
      status: 'sent',
      providerActionId: body.sid ?? input.providerCallId,
    };
  }

  private getTwilioAccountSid(
    config: VoiceReceptionistConfig,
  ): string | undefined {
    const settings = this.toRecord(config.settings);
    const value = settings.twilioAccountSid;

    return typeof value === 'string'
      ? value
      : this.configService.get<string>('TWILIO_ACCOUNT_SID');
  }

  private escapeTwiml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  buildGatherTwiml(config: VoiceReceptionistConfig, content: string): string {
    const gatherUrl = this.getTwilioCallbackUrl(
      config,
      'twilioGatherUrl',
      'gather',
    );
    if (!gatherUrl) {
      throw new ServiceUnavailableException(
        'VOICE_WEBHOOK_PUBLIC_BASE_URL or settings.twilioGatherUrl is required',
      );
    }
    const prompt = content ? this.sayTwiml(config, content) : '';
    return `<Response><Gather input="speech dtmf" action="${this.escapeTwiml(gatherUrl)}" method="POST" speechTimeout="auto" actionOnEmptyResult="true">${prompt}</Gather>${this.sayTwiml(config, 'I did not hear anything. Goodbye.')}<Hangup/></Response>`;
  }

  buildTransferTwiml(
    config: VoiceReceptionistConfig,
    transferTo: string,
  ): string {
    const callbackUrl = this.getTwilioCallbackUrl(
      config,
      'twilioDialCallbackUrl',
      'dial',
    );
    if (!callbackUrl) {
      throw new ServiceUnavailableException(
        'VOICE_WEBHOOK_PUBLIC_BASE_URL or settings.twilioDialCallbackUrl is required',
      );
    }
    const action = ` action="${this.escapeTwiml(callbackUrl)}" method="POST"`;
    return `<Response><Dial timeout="20" answerOnBridge="true"${action}>${this.escapeTwiml(transferTo)}</Dial></Response>`;
  }

  buildVoicemailTwiml(config: VoiceReceptionistConfig): string {
    const settings = this.toRecord(config.settings);
    const prompt =
      typeof settings.voicemailPrompt === 'string'
        ? settings.voicemailPrompt
        : 'Please leave a voicemail after the tone.';
    const maxLength =
      typeof settings.voicemailMaxLengthSeconds === 'number'
        ? Math.min(600, Math.max(10, settings.voicemailMaxLengthSeconds))
        : 120;
    const callbackUrl = this.getTwilioCallbackUrl(
      config,
      'twilioRecordingCallbackUrl',
      'recording',
    );
    if (!callbackUrl) {
      throw new ServiceUnavailableException(
        'VOICE_WEBHOOK_PUBLIC_BASE_URL or settings.twilioRecordingCallbackUrl is required',
      );
    }
    const callback = this.escapeTwiml(callbackUrl);
    return `<Response>${this.sayTwiml(config, prompt)}<Record maxLength="${maxLength}" playBeep="true" action="${callback}" method="POST" recordingStatusCallback="${callback}" recordingStatusCallbackMethod="POST" transcribe="true" transcribeCallback="${callback}"/><Hangup/></Response>`;
  }

  buildCloseTwiml(config: VoiceReceptionistConfig, content: string): string {
    return `<Response>${this.sayTwiml(config, content)}<Hangup/></Response>`;
  }

  private sayTwiml(config: VoiceReceptionistConfig, content: string): string {
    const voice = config.ttsVoice
      ? ` voice="${this.escapeTwiml(this.twilioVoice(config.ttsVoice))}"`
      : '';
    const language = ` language="${this.escapeTwiml(this.twilioLanguage(config.defaultLocale))}"`;
    return `<Say${voice}${language}>${this.escapeTwiml(content)}</Say>`;
  }

  private twilioVoice(voice: string): string {
    const aliases: Record<string, string> = {
      alloy: 'Polly.Joanna',
      echo: 'Polly.Matthew',
      fable: 'Polly.Amy',
      nova: 'Polly.Joanna',
      onyx: 'Polly.Matthew',
      shimmer: 'Polly.Joanna',
    };
    return aliases[voice] ?? voice;
  }

  private twilioLanguage(locale: string): string {
    const aliases: Record<string, string> = {
      en: 'en-US',
      es: 'es-ES',
      fr: 'fr-FR',
      de: 'de-DE',
      hi: 'hi-IN',
    };
    return aliases[locale] ?? locale;
  }

  private getTwilioCallbackUrl(
    config: VoiceReceptionistConfig,
    key: string,
    callback: 'gather' | 'dial' | 'recording',
  ): string | undefined {
    const value = this.toRecord(config.settings)[key];
    if (typeof value === 'string' && /^https:\/\//.test(value)) return value;
    const baseUrl = this.configService
      .get<string>('VOICE_WEBHOOK_PUBLIC_BASE_URL')
      ?.replace(/\/$/, '');
    return baseUrl
      ? `${baseUrl}/api/v1/voice-receptionist/webhook/${config.id}/twilio/${callback}`
      : undefined;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
