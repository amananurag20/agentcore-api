import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export enum VoiceProviderTypeDto {
  twilio = 'twilio',
  sip = 'sip',
  custom = 'custom',
}

export enum VoiceConfigStatusDto {
  active = 'active',
  inactive = 'inactive',
}

export enum VoiceCallStatusDto {
  ringing = 'ringing',
  in_progress = 'in_progress',
  waiting_for_agent = 'waiting_for_agent',
  transferred = 'transferred',
  voicemail = 'voicemail',
  completed = 'completed',
  failed = 'failed',
}

export enum VoiceCallEventTypeDto {
  call_started = 'call_started',
  stt_partial = 'stt_partial',
  transcript = 'transcript',
  assistant_response = 'assistant_response',
  tts_started = 'tts_started',
  barge_in = 'barge_in',
  route_decision = 'route_decision',
  transfer_requested = 'transfer_requested',
  voicemail = 'voicemail',
  call_ended = 'call_ended',
  system = 'system',
}

export enum VoiceRouteActionDto {
  transfer = 'transfer',
  voicemail = 'voicemail',
  close = 'close',
}

export class CreateVoiceConfigDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Main Receptionist' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ enum: VoiceProviderTypeDto, example: 'twilio' })
  @IsEnum(VoiceProviderTypeDto)
  @IsOptional()
  provider?: VoiceProviderTypeDto;

  @ApiPropertyOptional({ enum: VoiceConfigStatusDto, example: 'active' })
  @IsEnum(VoiceConfigStatusDto)
  @IsOptional()
  status?: VoiceConfigStatusDto;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  phoneNumber?: string;

  @ApiPropertyOptional({ example: 'sip.agentcore.example.com' })
  @IsString()
  @IsOptional()
  sipDomain?: string;

  @ApiPropertyOptional({ example: 'voice-webhook-token' })
  @IsString()
  @IsOptional()
  webhookVerifyToken?: string;

  @ApiPropertyOptional({ example: 'provider-secret' })
  @IsString()
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional({ example: 'openai' })
  @IsString()
  @IsOptional()
  sttProvider?: string;

  @ApiPropertyOptional({ example: 'gpt-4o-transcribe' })
  @IsString()
  @IsOptional()
  sttModel?: string;

  @ApiPropertyOptional({ example: 'openai' })
  @IsString()
  @IsOptional()
  ttsProvider?: string;

  @ApiPropertyOptional({ example: 'alloy' })
  @IsString()
  @IsOptional()
  ttsVoice?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  defaultLocale?: string;

  @ApiPropertyOptional({ example: '+15559876543' })
  @IsString()
  @IsOptional()
  transferPhoneNumber?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  voicemailEnabled?: boolean;

  @ApiPropertyOptional({
    example: {
      businessHours: {
        enabled: true,
        days: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '18:00',
      },
      routingKeywords: { sales: '+15550001111' },
    },
  })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class UpdateVoiceConfigDto {
  @ApiPropertyOptional({ example: 'Main Receptionist' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: VoiceProviderTypeDto })
  @IsEnum(VoiceProviderTypeDto)
  @IsOptional()
  provider?: VoiceProviderTypeDto;

  @ApiPropertyOptional({ enum: VoiceConfigStatusDto })
  @IsEnum(VoiceConfigStatusDto)
  @IsOptional()
  status?: VoiceConfigStatusDto;

  @ApiPropertyOptional({ example: '+15551234567', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  phoneNumber?: string | null;

  @ApiPropertyOptional({ example: 'sip.agentcore.example.com', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  sipDomain?: string | null;

  @ApiPropertyOptional({ example: 'voice-webhook-token', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  webhookVerifyToken?: string | null;

  @ApiPropertyOptional({ example: 'provider-secret', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  apiKey?: string | null;

  @ApiPropertyOptional({ example: 'openai', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  sttProvider?: string | null;

  @ApiPropertyOptional({ example: 'gpt-4o-transcribe', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  sttModel?: string | null;

  @ApiPropertyOptional({ example: 'openai', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  ttsProvider?: string | null;

  @ApiPropertyOptional({ example: 'alloy', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  ttsVoice?: string | null;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  defaultLocale?: string;

  @ApiPropertyOptional({ example: '+15559876543', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  transferPhoneNumber?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  voicemailEnabled?: boolean;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class ListVoiceCallsDto {
  @ApiPropertyOptional({ enum: VoiceCallStatusDto })
  @IsEnum(VoiceCallStatusDto)
  @IsOptional()
  status?: VoiceCallStatusDto;

  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100 })
  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;
}

export class VoiceWebhookEventDto {
  @ApiPropertyOptional({ example: 'CA123456789' })
  @IsString()
  @IsOptional()
  providerCallId?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  fromNumber?: string;

  @ApiPropertyOptional({ example: '+15557654321' })
  @IsString()
  @IsOptional()
  toNumber?: string;

  @ApiPropertyOptional({ example: 'Ada Customer' })
  @IsString()
  @IsOptional()
  callerName?: string;

  @ApiProperty({ enum: VoiceCallEventTypeDto, example: 'transcript' })
  @IsEnum(VoiceCallEventTypeDto)
  eventType: VoiceCallEventTypeDto;

  @ApiPropertyOptional({ example: 'I want to book an appointment.' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ example: 0.94 })
  @IsNumber()
  @IsOptional()
  confidence?: number;

  @ApiPropertyOptional({ example: 'https://example.com/call-recording.wav' })
  @IsString()
  @IsOptional()
  audioUrl?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({ example: { rawProviderPayload: true } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class SendVoiceAgentMessageDto {
  @ApiProperty({ example: 'A human agent is joining the call now.' })
  @IsString()
  @MinLength(1)
  content: string;
}

export class AssignVoiceCallDto {
  @ApiPropertyOptional({
    example: 'ecfdf154-2b72-477e-b286-43120fe69ead',
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  assignedAgentId?: string | null;
}

export class UpdateVoiceCallStatusDto {
  @ApiProperty({ enum: VoiceCallStatusDto })
  @IsEnum(VoiceCallStatusDto)
  status: VoiceCallStatusDto;
}

export class RouteVoiceCallDto {
  @ApiProperty({ enum: VoiceRouteActionDto })
  @IsEnum(VoiceRouteActionDto)
  action: VoiceRouteActionDto;

  @ApiPropertyOptional({ example: '+15559876543' })
  @IsString()
  @IsOptional()
  transferTo?: string;

  @ApiPropertyOptional({ example: 'Caller asked for sales.' })
  @IsString()
  @IsOptional()
  reason?: string;
}
