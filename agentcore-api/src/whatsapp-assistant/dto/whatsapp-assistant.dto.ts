import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export enum WhatsAppProviderTypeDto {
  meta = 'meta',
  twilio = 'twilio',
  custom = 'custom',
}

export enum WhatsAppConfigStatusDto {
  active = 'active',
  inactive = 'inactive',
}

export enum WhatsAppConversationStatusDto {
  open = 'open',
  waiting_for_agent = 'waiting_for_agent',
  closed = 'closed',
}

export enum WhatsAppMessageTypeDto {
  text = 'text',
  template = 'template',
  image = 'image',
  audio = 'audio',
  video = 'video',
  document = 'document',
  sticker = 'sticker',
  location = 'location',
  interactive = 'interactive',
  contact = 'contact',
  reaction = 'reaction',
  unknown = 'unknown',
}

export enum WhatsAppConsentStatusDto {
  unknown = 'unknown',
  opted_in = 'opted_in',
  opted_out = 'opted_out',
}

export class CreateWhatsAppConfigDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Primary WhatsApp' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ enum: WhatsAppProviderTypeDto, example: 'meta' })
  @IsEnum(WhatsAppProviderTypeDto)
  @IsOptional()
  provider?: WhatsAppProviderTypeDto;

  @ApiPropertyOptional({ enum: WhatsAppConfigStatusDto, example: 'active' })
  @IsEnum(WhatsAppConfigStatusDto)
  @IsOptional()
  status?: WhatsAppConfigStatusDto;

  @ApiPropertyOptional({ example: '1234567890' })
  @IsString()
  @IsOptional()
  phoneNumberId?: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsString()
  @IsOptional()
  businessAccountId?: string;

  @ApiPropertyOptional({ example: 'EAAG...' })
  @IsString()
  @IsOptional()
  accessToken?: string;

  @ApiPropertyOptional({ example: 'verify-token-from-meta' })
  @IsString()
  @IsOptional()
  webhookVerifyToken?: string;

  @ApiPropertyOptional({ example: 'app-secret' })
  @IsString()
  @IsOptional()
  appSecret?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  defaultLocale?: string;

  @ApiPropertyOptional({ example: { handoffKeywords: ['agent', 'human'] } })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class UpdateWhatsAppConfigDto {
  @ApiPropertyOptional({ example: 'Primary WhatsApp' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: WhatsAppProviderTypeDto })
  @IsEnum(WhatsAppProviderTypeDto)
  @IsOptional()
  provider?: WhatsAppProviderTypeDto;

  @ApiPropertyOptional({ enum: WhatsAppConfigStatusDto })
  @IsEnum(WhatsAppConfigStatusDto)
  @IsOptional()
  status?: WhatsAppConfigStatusDto;

  @ApiPropertyOptional({ example: '1234567890', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  phoneNumberId?: string | null;

  @ApiPropertyOptional({ example: '9876543210', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  businessAccountId?: string | null;

  @ApiPropertyOptional({ example: 'EAAG...', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  accessToken?: string | null;

  @ApiPropertyOptional({ example: 'verify-token-from-meta', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  webhookVerifyToken?: string | null;

  @ApiPropertyOptional({ example: 'app-secret', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  appSecret?: string | null;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  defaultLocale?: string;

  @ApiPropertyOptional({ example: { handoffKeywords: ['agent', 'human'] } })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class ListWhatsAppConversationsDto {
  @ApiPropertyOptional({ enum: WhatsAppConversationStatusDto })
  @IsEnum(WhatsAppConversationStatusDto)
  @IsOptional()
  status?: WhatsAppConversationStatusDto;

  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: '15551234567' })
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

export class SendWhatsAppAgentMessageDto {
  @ApiProperty({ example: 'Thanks for waiting. A human agent can help.' })
  @IsString()
  @MinLength(1)
  content: string;
}

export class SendWhatsAppTemplateMessageDto {
  @ApiProperty({ example: 'order_update' })
  @IsString()
  @MinLength(1)
  templateName: string;

  @ApiPropertyOptional({ example: 'en_US' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    example: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  @IsOptional()
  components?: Record<string, unknown>[];
}

export class SendWhatsAppProactiveTemplateDto extends SendWhatsAppTemplateMessageDto {
  @ApiProperty({ example: '+15551234567' })
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'contactWaId must be a valid E.164 WhatsApp number',
  })
  contactWaId: string;

  @ApiPropertyOptional({ example: 'Ada Customer' })
  @IsString()
  @IsOptional()
  contactName?: string;

  @ApiProperty({ example: 'website_checkout_checkbox' })
  @IsString()
  @MinLength(2)
  optInSource: string;
}

export enum WhatsAppTemplateCategoryDto {
  marketing = 'MARKETING',
  utility = 'UTILITY',
  authentication = 'AUTHENTICATION',
}

export class CreateWhatsAppTemplateDto {
  @ApiProperty({ example: 'appointment_reminder' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,511}$/, {
    message:
      'Template name must start with a letter and contain only lowercase letters, numbers, and underscores',
  })
  name: string;

  @ApiProperty({ example: 'en_US' })
  @IsString()
  @Matches(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, {
    message: 'Template language must look like en or en_US',
  })
  language: string;

  @ApiProperty({ enum: WhatsAppTemplateCategoryDto })
  @IsEnum(WhatsAppTemplateCategoryDto)
  category: WhatsAppTemplateCategoryDto;

  @ApiProperty({
    example: [{ type: 'BODY', text: 'Hello {{1}}' }],
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  components: Record<string, unknown>[];
}

export class UpdateWhatsAppTemplateDto {
  @ApiPropertyOptional({ example: 'appointment_reminder' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,511}$/, {
    message:
      'Template name must start with a letter and contain only lowercase letters, numbers, and underscores',
  })
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'en_US' })
  @IsString()
  @Matches(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, {
    message: 'Template language must look like en or en_US',
  })
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({ enum: WhatsAppTemplateCategoryDto })
  @IsEnum(WhatsAppTemplateCategoryDto)
  @IsOptional()
  category?: WhatsAppTemplateCategoryDto;

  @ApiPropertyOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  @IsOptional()
  components?: Record<string, unknown>[];
}

export enum WhatsAppOutboundMediaTypeDto {
  image = 'image',
  audio = 'audio',
  video = 'video',
  document = 'document',
}

export enum WhatsAppInteractiveKindDto {
  button = 'button',
  list = 'list',
}

export class SendWhatsAppInteractiveMessageDto {
  @ApiProperty({ enum: WhatsAppInteractiveKindDto })
  @IsEnum(WhatsAppInteractiveKindDto)
  kind: WhatsAppInteractiveKindDto;

  @ApiProperty({ example: 'How can we help?' })
  @IsString()
  @MinLength(1)
  body: string;

  @ApiPropertyOptional({ example: 'Choose an option' })
  @IsString()
  @IsOptional()
  header?: string;

  @ApiPropertyOptional({ example: 'AgentCore support' })
  @IsString()
  @IsOptional()
  footer?: string;

  @ApiPropertyOptional({ example: 'View options' })
  @IsString()
  @IsOptional()
  buttonText?: string;

  @ApiPropertyOptional({ example: [{ id: 'sales', title: 'Sales' }] })
  @IsArray()
  @ArrayMaxSize(3)
  @IsObject({ each: true })
  @IsOptional()
  buttons?: Record<string, unknown>[];

  @ApiPropertyOptional({
    example: [
      {
        title: 'Departments',
        rows: [{ id: 'support', title: 'Support' }],
      },
    ],
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  @IsOptional()
  sections?: Record<string, unknown>[];
}

export class SendWhatsAppMediaMessageDto {
  @ApiProperty({ enum: WhatsAppOutboundMediaTypeDto })
  @IsEnum(WhatsAppOutboundMediaTypeDto)
  type: WhatsAppOutboundMediaTypeDto;

  @ApiPropertyOptional({ example: '1234567890' })
  @IsString()
  @IsOptional()
  mediaId?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/invoice.pdf' })
  @IsString()
  @IsOptional()
  link?: string;

  @ApiPropertyOptional({ example: 'Your invoice' })
  @IsString()
  @IsOptional()
  caption?: string;

  @ApiPropertyOptional({ example: 'invoice.pdf' })
  @IsString()
  @IsOptional()
  filename?: string;
}

export class UpdateWhatsAppConversationStatusDto {
  @ApiProperty({ enum: WhatsAppConversationStatusDto })
  @IsEnum(WhatsAppConversationStatusDto)
  status: WhatsAppConversationStatusDto;
}

export class UpdateWhatsAppConsentDto {
  @ApiProperty({ enum: WhatsAppConsentStatusDto })
  @IsEnum(WhatsAppConsentStatusDto)
  status: WhatsAppConsentStatusDto;

  @ApiPropertyOptional({ example: 'website_checkout_checkbox' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  source?: string;
}

export class AssignWhatsAppConversationDto {
  @ApiPropertyOptional({
    example: 'ecfdf154-2b72-477e-b286-43120fe69ead',
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  assignedAgentId?: string | null;
}

export class WhatsAppInboundWebhookDto {
  @ApiProperty({ example: '15551234567' })
  @IsString()
  contactWaId: string;

  @ApiPropertyOptional({ example: 'Ada Customer' })
  @IsString()
  @IsOptional()
  contactName?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'wamid.HBg...' })
  @IsString()
  @IsOptional()
  providerMessageId?: string;

  @ApiPropertyOptional({ enum: WhatsAppMessageTypeDto, example: 'text' })
  @IsEnum(WhatsAppMessageTypeDto)
  @IsOptional()
  type?: WhatsAppMessageTypeDto;

  @ApiPropertyOptional({ example: 'What are your business hours?' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ example: 'https://example.com/file.jpg' })
  @IsString()
  @IsOptional()
  mediaUrl?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsString()
  @IsOptional()
  mediaMimeType?: string;

  @ApiPropertyOptional({ example: 'sha256' })
  @IsString()
  @IsOptional()
  mediaSha256?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({ example: { rawProviderPayload: true } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
