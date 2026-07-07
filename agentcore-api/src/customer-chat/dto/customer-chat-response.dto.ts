import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CustomerChatCitationDto {
  @ApiProperty({ example: 'f2fd8f8f-f871-4506-a326-6bfd67fd1519' })
  chunkId: string;

  @ApiProperty({ example: 0.82 })
  score: number;

  @ApiProperty({ example: 'Business hours are 9am to 6pm.' })
  content: string;
}

export class CustomerChatMessageDto {
  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  id: string;

  @ApiProperty({ enum: ['visitor', 'assistant', 'agent', 'system'] })
  role: 'visitor' | 'assistant' | 'agent' | 'system';

  @ApiProperty({ example: 'Business hours are 9am to 6pm.' })
  content: string;

  @ApiProperty({ example: {} })
  metadata: Record<string, unknown>;

  @ApiProperty({ type: CustomerChatCitationDto, isArray: true })
  citations: CustomerChatCitationDto[];

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;
}

export class CustomerChatConversationDto {
  @ApiProperty({ example: 'd8f7d2d2-8f8f-4d34-a58d-f87ef8912e2f' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiProperty({ enum: ['open', 'waiting_for_agent', 'closed'] })
  status: 'open' | 'waiting_for_agent' | 'closed';

  @ApiPropertyOptional({ example: 'visitor_123' })
  visitorId?: string | null;

  @ApiPropertyOptional({ example: 'Ada Visitor' })
  visitorName?: string | null;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  visitorEmail?: string | null;

  @ApiPropertyOptional({
    example: 'ecfdf154-2b72-477e-b286-43120fe69ead',
  })
  assignedAgentId?: string | null;

  @ApiProperty({ example: {} })
  metadata: Record<string, unknown>;

  @ApiProperty({ type: CustomerChatMessageDto, isArray: true })
  messages: CustomerChatMessageDto[];

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  updatedAt: Date;
}

export class CustomerChatSendMessageResponseDto {
  @ApiProperty({ type: CustomerChatConversationDto })
  conversation: CustomerChatConversationDto;

  @ApiProperty({ type: CustomerChatMessageDto })
  visitorMessage: CustomerChatMessageDto;

  @ApiProperty({ type: CustomerChatMessageDto })
  assistantMessage: CustomerChatMessageDto;
}

export class CustomerChatConversationListDto {
  @ApiProperty({ type: CustomerChatConversationDto, isArray: true })
  data: CustomerChatConversationDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;
}

export class CustomerChatAgentMessageResponseDto {
  @ApiProperty({ type: CustomerChatConversationDto })
  conversation: CustomerChatConversationDto;

  @ApiProperty({ type: CustomerChatMessageDto })
  agentMessage: CustomerChatMessageDto;
}

export class CustomerChatWidgetConfigDto {
  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiProperty({ example: 'a6f7961d-cf93-47c4-a0fe-9238a0b2f729' })
  widgetKey: string;

  @ApiProperty({ example: true })
  enabled: boolean;

  @ApiProperty({ example: 'Hi! How can I help you today?' })
  greetingText: string;

  @ApiProperty({ example: ['https://example.com'], isArray: true })
  allowedDomains: string[];

  @ApiProperty({ example: {} })
  settings: Record<string, unknown>;
}

export class PublicCustomerChatConversationCreatedDto {
  @ApiProperty({ type: CustomerChatConversationDto })
  conversation: CustomerChatConversationDto;

  @ApiProperty({ example: 'visitor-session-token' })
  visitorToken: string;
}
