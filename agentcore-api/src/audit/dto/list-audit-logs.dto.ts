import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListAuditLogsDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'customer_chat.conversation.assigned' })
  @IsString()
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ example: 'customer_chat_conversation' })
  @IsString()
  @IsOptional()
  entityType?: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsString()
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsString()
  @IsOptional()
  actorUserId?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ example: 50, minimum: 1, maximum: 100 })
  @Transform(({ value }) => Number(value ?? 50))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 50;
}
