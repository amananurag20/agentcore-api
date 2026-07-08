import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  VoiceCallEventTypeDto,
  VoiceCallStatusDto,
  VoiceConfigStatusDto,
  VoiceProviderTypeDto,
} from './voice-receptionist.dto';

export class VoiceConfigResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty({ enum: VoiceProviderTypeDto })
  provider: VoiceProviderTypeDto;

  @ApiProperty({ enum: VoiceConfigStatusDto })
  status: VoiceConfigStatusDto;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  phoneNumber?: string | null;

  @ApiPropertyOptional()
  sipDomain?: string | null;

  @ApiProperty()
  hasWebhookVerifyToken: boolean;

  @ApiProperty()
  hasApiKey: boolean;

  @ApiPropertyOptional()
  sttProvider?: string | null;

  @ApiPropertyOptional()
  sttModel?: string | null;

  @ApiPropertyOptional()
  ttsProvider?: string | null;

  @ApiPropertyOptional()
  ttsVoice?: string | null;

  @ApiProperty()
  defaultLocale: string;

  @ApiPropertyOptional()
  transferPhoneNumber?: string | null;

  @ApiProperty()
  voicemailEnabled: boolean;

  @ApiProperty()
  settings: Record<string, unknown>;
}

export class VoiceCallEventResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  callId: string;

  @ApiProperty({ enum: VoiceCallEventTypeDto })
  type: VoiceCallEventTypeDto;

  @ApiProperty()
  role: string;

  @ApiPropertyOptional()
  content?: string | null;

  @ApiPropertyOptional()
  confidence?: number | null;

  @ApiPropertyOptional()
  audioUrl?: string | null;

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiProperty()
  createdAt: Date;
}

export class VoiceCallResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  configId: string;

  @ApiProperty({ enum: VoiceCallStatusDto })
  status: VoiceCallStatusDto;

  @ApiPropertyOptional()
  providerCallId?: string | null;

  @ApiPropertyOptional()
  fromNumber?: string | null;

  @ApiPropertyOptional()
  toNumber?: string | null;

  @ApiPropertyOptional()
  callerName?: string | null;

  @ApiProperty()
  locale: string;

  @ApiPropertyOptional()
  assignedAgentId?: string | null;

  @ApiProperty()
  startedAt: Date;

  @ApiPropertyOptional()
  endedAt?: Date | null;

  @ApiProperty()
  lastEventAt: Date;

  @ApiPropertyOptional()
  summary?: string | null;

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiProperty({ type: VoiceCallEventResponseDto, isArray: true })
  events: VoiceCallEventResponseDto[];
}

export class VoiceCallListResponseDto {
  @ApiProperty({ type: VoiceCallResponseDto, isArray: true })
  data: VoiceCallResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;
}

export class VoiceWebhookResponseDto {
  @ApiProperty({ type: VoiceCallResponseDto })
  call: VoiceCallResponseDto;

  @ApiProperty({ type: VoiceCallEventResponseDto })
  inboundEvent: VoiceCallEventResponseDto;

  @ApiPropertyOptional({ type: VoiceCallEventResponseDto })
  assistantEvent?: VoiceCallEventResponseDto | null;

  @ApiProperty()
  action: {
    provider: string;
    status: string;
    providerActionId?: string;
  };
}
