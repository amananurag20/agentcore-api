import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuditLogDto {
  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  id: string;

  @ApiPropertyOptional({ example: 'org_demo' })
  organizationId?: string | null;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  actorUserId?: string | null;

  @ApiPropertyOptional({ example: 'admin@agentcore.local' })
  actorEmail?: string | null;

  @ApiProperty({ example: 'customer_chat.conversation.assigned' })
  action: string;

  @ApiProperty({ example: 'customer_chat_conversation' })
  entityType: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  entityId?: string | null;

  @ApiProperty({ example: {} })
  metadata: Record<string, unknown>;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;
}

export class AuditLogListDto {
  @ApiProperty({ type: AuditLogDto, isArray: true })
  data: AuditLogDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 50 })
  limit: number;
}
