import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum LeadCaptureFieldTypeDto {
  text = 'text',
  email = 'email',
  phone = 'phone',
  number = 'number',
  textarea = 'textarea',
  select = 'select',
  radio = 'radio',
  checkbox = 'checkbox',
}

export enum LeadCaptureFieldMappingDto {
  name = 'name',
  email = 'email',
  phone = 'phone',
  custom = 'custom',
}

export class CustomerChatLeadFieldInputDto {
  @ApiProperty({ example: 'email' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  key: string;

  @ApiProperty({ example: 'Work email' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @ApiProperty({ enum: LeadCaptureFieldTypeDto })
  @IsEnum(LeadCaptureFieldTypeDto)
  type: LeadCaptureFieldTypeDto;

  @ApiPropertyOptional({ enum: LeadCaptureFieldMappingDto, default: 'custom' })
  @IsEnum(LeadCaptureFieldMappingDto)
  @IsOptional()
  mapping?: LeadCaptureFieldMappingDto;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'you@example.com' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  placeholder?: string;

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @IsOptional()
  options?: string[];
}

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

  @ApiPropertyOptional({ type: CustomerChatLeadFieldInputDto, isArray: true })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CustomerChatLeadFieldInputDto)
  @IsOptional()
  leadFields?: CustomerChatLeadFieldInputDto[];
}

export class UpdateCustomerChatWidgetConfigDto extends PartialType(
  CreateCustomerChatWidgetConfigDto,
) {}
