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
      const gatherUrl = this.getTwilioCallbackUrl(
        input.config,
        'twilioGatherUrl',
      );
      if (!gatherUrl) {
        throw new ServiceUnavailableException(
          'settings.twilioGatherUrl is required for an interactive Twilio call',
        );
      }
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.gatherTwiml(input.content, gatherUrl),
        actionPrefix: 'twilio-tts',
      });
    }

    return this.mockSpeakText(input);
  }

  async interruptCall(input: {
    config: VoiceReceptionistConfig;
    providerCallId?: string | null;
  }): Promise<VoiceProviderActionResult> {
    if (this.shouldUseLiveTwilio(input.config)) {
      const gatherUrl = this.getTwilioCallbackUrl(
        input.config,
        'twilioGatherUrl',
      );
      if (!gatherUrl) {
        throw new ServiceUnavailableException(
          'settings.twilioGatherUrl is required to interrupt Twilio playback',
        );
      }
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: this.gatherTwiml('', gatherUrl),
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
        twiml: `<Response><Dial timeout="20">${this.escapeTwiml(input.transferTo)}</Dial></Response>`,
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
      const settings = this.toRecord(input.config.settings);
      const prompt =
        typeof settings.voicemailPrompt === 'string'
          ? settings.voicemailPrompt
          : 'Please leave a voicemail after the tone.';
      const maxLength =
        typeof settings.voicemailMaxLengthSeconds === 'number'
          ? Math.min(600, Math.max(10, settings.voicemailMaxLengthSeconds))
          : 120;
      return this.updateTwilioCall({
        config: input.config,
        providerCallId: input.providerCallId,
        twiml: `<Response><Say>${this.escapeTwiml(prompt)}</Say><Record maxLength="${maxLength}" playBeep="true" /></Response>`,
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

  private gatherTwiml(content: string, gatherUrl: string): string {
    const prompt = content ? `<Say>${this.escapeTwiml(content)}</Say>` : '';
    return `<Response><Gather input="speech dtmf" action="${this.escapeTwiml(gatherUrl)}" method="POST" speechTimeout="auto" actionOnEmptyResult="true">${prompt}</Gather></Response>`;
  }

  private getTwilioCallbackUrl(
    config: VoiceReceptionistConfig,
    key: string,
  ): string | undefined {
    const value = this.toRecord(config.settings)[key];
    return typeof value === 'string' && /^https:\/\//.test(value)
      ? value
      : undefined;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
