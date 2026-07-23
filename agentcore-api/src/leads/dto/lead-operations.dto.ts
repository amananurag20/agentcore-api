import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeadConsentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class AssignLeadDto {
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  ownerId?: string | null;
}

export class UpdateLeadConsentDto {
  @IsEnum(LeadConsentStatus)
  status!: LeadConsentStatus;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  source!: string;
}

export class ListLeadAlertsDto {
  @IsString()
  @IsOptional()
  organizationId?: string;

  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;

  @Transform(({ value }) => Number(value ?? 50))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 50;
}

export const LEAD_WEBHOOK_EVENTS = [
  'lead.created',
  'lead.updated',
  'lead.priority_changed',
  'lead.assigned',
  'lead.first_response',
  'lead.sla_breached',
  'lead.converted',
  'lead.deleted',
] as const;

export class CreateLeadWebhookDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  url!: string;

  @IsString()
  @MinLength(16)
  @MaxLength(500)
  secret!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(LEAD_WEBHOOK_EVENTS, { each: true })
  events!: string[];
}

export class UpdateLeadWebhookDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  @IsOptional()
  url?: string;

  @IsString()
  @MinLength(16)
  @MaxLength(500)
  @IsOptional()
  secret?: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(LEAD_WEBHOOK_EVENTS, { each: true })
  @IsOptional()
  events?: string[];
}

export class ListLeadWebhookDeliveriesDto {
  @ApiPropertyOptional()
  @IsUUID('4')
  @IsOptional()
  endpointId?: string;

  @Transform(({ value }) => Number(value ?? 50))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 50;
}
