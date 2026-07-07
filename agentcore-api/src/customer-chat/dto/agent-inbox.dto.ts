import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MinLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum CustomerChatConversationStatusDto {
  open = 'open',
  waiting_for_agent = 'waiting_for_agent',
  closed = 'closed',
}

export class ListCustomerChatConversationsDto {
  @ApiPropertyOptional({ enum: CustomerChatConversationStatusDto })
  @IsEnum(CustomerChatConversationStatusDto)
  @IsOptional()
  status?: CustomerChatConversationStatusDto;

  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  assignedAgentId?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
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

export class SendAgentCustomerChatMessageDto {
  @ApiProperty({ example: 'Thanks for waiting. I can help with that.' })
  @IsString()
  @MinLength(1)
  content: string;
}

export class AssignCustomerChatConversationDto {
  @ApiPropertyOptional({
    example: 'ecfdf154-2b72-477e-b286-43120fe69ead',
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  assignedAgentId?: string | null;
}

export class UpdateCustomerChatConversationStatusDto {
  @ApiProperty({ enum: CustomerChatConversationStatusDto })
  @IsEnum(CustomerChatConversationStatusDto)
  status: CustomerChatConversationStatusDto;
}
