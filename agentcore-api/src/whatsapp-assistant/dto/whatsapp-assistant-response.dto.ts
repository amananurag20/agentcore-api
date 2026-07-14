import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  WhatsAppConfigStatusDto,
  WhatsAppConversationStatusDto,
  WhatsAppMessageTypeDto,
  WhatsAppProviderTypeDto,
} from './whatsapp-assistant.dto';

export class WhatsAppConfigResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty({ enum: WhatsAppProviderTypeDto })
  provider: WhatsAppProviderTypeDto;

  @ApiProperty({ enum: WhatsAppConfigStatusDto })
  status: WhatsAppConfigStatusDto;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  phoneNumberId?: string | null;

  @ApiPropertyOptional()
  businessAccountId?: string | null;

  @ApiProperty()
  hasAccessToken: boolean;

  @ApiProperty()
  hasWebhookVerifyToken: boolean;

  @ApiProperty()
  hasAppSecret: boolean;

  @ApiProperty()
  defaultLocale: string;

  @ApiProperty()
  settings: Record<string, unknown>;
}

export class WhatsAppTemplateResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  configId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  language: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional()
  category?: string | null;

  @ApiProperty()
  components: unknown[];

  @ApiProperty()
  syncedAt: Date;
}

export class WhatsAppMessageResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  conversationId: string;

  @ApiProperty()
  direction: string;

  @ApiProperty()
  role: string;

  @ApiProperty({ enum: WhatsAppMessageTypeDto })
  type: WhatsAppMessageTypeDto;

  @ApiPropertyOptional()
  providerMessageId?: string | null;

  @ApiPropertyOptional()
  content?: string | null;

  @ApiPropertyOptional()
  mediaUrl?: string | null;

  @ApiPropertyOptional()
  mediaMimeType?: string | null;

  @ApiPropertyOptional()
  deliveryStatus?: string | null;

  @ApiPropertyOptional()
  deliveryError?: string | null;

  @ApiProperty()
  deliveryAttempts: number;

  @ApiPropertyOptional()
  deliveredAt?: Date | null;

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiProperty()
  createdAt: Date;
}

export class WhatsAppConversationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  configId: string;

  @ApiProperty({ enum: WhatsAppConversationStatusDto })
  status: WhatsAppConversationStatusDto;

  @ApiProperty()
  contactWaId: string;

  @ApiPropertyOptional()
  contactName?: string | null;

  @ApiPropertyOptional()
  contactPhone?: string | null;

  @ApiProperty()
  locale: string;

  @ApiPropertyOptional()
  assignedAgentId?: string | null;

  @ApiPropertyOptional()
  sessionExpiresAt?: Date | null;

  @ApiProperty()
  lastMessageAt: Date;

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiProperty({ type: WhatsAppMessageResponseDto, isArray: true })
  messages: WhatsAppMessageResponseDto[];
}

export class WhatsAppConversationListResponseDto {
  @ApiProperty({ type: WhatsAppConversationResponseDto, isArray: true })
  data: WhatsAppConversationResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;
}

export class WhatsAppInboundWebhookResponseDto {
  @ApiProperty({ type: WhatsAppConversationResponseDto })
  conversation: WhatsAppConversationResponseDto;

  @ApiProperty({ type: WhatsAppMessageResponseDto })
  inboundMessage: WhatsAppMessageResponseDto;

  @ApiPropertyOptional({ type: WhatsAppMessageResponseDto })
  assistantMessage?: WhatsAppMessageResponseDto | null;

  @ApiProperty()
  delivery: {
    provider: string;
    status: string;
  };
}
