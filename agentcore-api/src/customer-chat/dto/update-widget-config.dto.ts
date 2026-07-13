import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateCustomerChatWidgetConfigDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Sales Assistant', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ['all', 'folders'], default: 'all' })
  @IsString()
  @IsIn(['all', 'folders'])
  @IsOptional()
  knowledgeScope?: 'all' | 'folders';

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  folderIds?: string[];

  @ApiPropertyOptional({ example: 'Hi! How can I help you today?' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  greetingText?: string;

  @ApiPropertyOptional({
    example: ['https://example.com', 'https://www.example.com'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedDomains?: string[];

  @ApiPropertyOptional({ example: { primaryColor: '#111827' } })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class UpdateCustomerChatWidgetConfigDto extends PartialType(
  CreateCustomerChatWidgetConfigDto,
) {}
