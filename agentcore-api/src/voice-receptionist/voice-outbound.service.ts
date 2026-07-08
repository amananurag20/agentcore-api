import { Injectable, Logger } from '@nestjs/common';
import { VoiceReceptionistConfig } from '@prisma/client';

export type VoiceProviderActionResult = {
  provider: 'mock';
  status: 'queued';
  providerActionId: string;
};

@Injectable()
export class VoiceOutboundService {
  private readonly logger = new Logger(VoiceOutboundService.name);

  speakText(input: {
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

  transferCall(input: {
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

  sendToVoicemail(input: {
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
}
