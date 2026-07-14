import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export enum AppointmentRecurrenceFrequencyDto {
  daily = 'daily',
  weekly = 'weekly',
  monthly = 'monthly',
}

export enum AppointmentReminderChannelDto {
  email = 'email',
  sms = 'sms',
  whatsapp = 'whatsapp',
}

export class AppointmentRecurrenceDto {
  @ApiProperty({ enum: AppointmentRecurrenceFrequencyDto })
  @IsEnum(AppointmentRecurrenceFrequencyDto)
  frequency: AppointmentRecurrenceFrequencyDto;

  @ApiPropertyOptional({ minimum: 1, maximum: 12, default: 1 })
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  interval = 1;

  @ApiProperty({ minimum: 2, maximum: 52 })
  @IsInt()
  @Min(2)
  @Max(52)
  count: number;
}

export class UpdateAppointmentPolicyDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 43200 })
  @IsInt()
  @Min(0)
  @Max(43200)
  @IsOptional()
  cancellationWindowMinutes?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 43200 })
  @IsInt()
  @Min(0)
  @Max(43200)
  @IsOptional()
  rescheduleWindowMinutes?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10080 })
  @IsInt()
  @Min(0)
  @Max(10080)
  @IsOptional()
  noShowGraceMinutes?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1440 })
  @IsInt()
  @Min(1)
  @Max(1440)
  @IsOptional()
  waitlistOfferMinutes?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  quietHoursEnabled?: boolean;

  @ApiPropertyOptional({ example: '21:00' })
  @Matches(timePattern)
  @IsOptional()
  quietHoursStart?: string;

  @ApiPropertyOptional({ example: '08:00' })
  @Matches(timePattern)
  @IsOptional()
  quietHoursEnd?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  quietHoursTimezone?: string;
}

export class CreateAppointmentBlackoutDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Company holiday' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty()
  @IsISO8601()
  startAt: string;

  @ApiProperty()
  @IsISO8601()
  endAt: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  annual?: boolean;
}

export class JoinAppointmentWaitlistDto {
  @ApiProperty()
  @IsString()
  organizationId: string;

  @ApiProperty()
  @IsUUID()
  serviceId: string;

  @ApiProperty()
  @IsUUID()
  staffId: string;

  @ApiProperty()
  @IsISO8601()
  startAt: string;

  @ApiPropertyOptional({ example: 'UTC' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  customerName: string;

  @ApiPropertyOptional()
  @ValidateIf((input: JoinAppointmentWaitlistDto) => !input.customerPhone)
  @IsEmail()
  customerEmail?: string;

  @ApiPropertyOptional()
  @ValidateIf((input: JoinAppointmentWaitlistDto) => !input.customerEmail)
  @IsString()
  customerPhone?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  partySize = 1;
}

export class ClaimAppointmentWaitlistDto {
  @ApiProperty()
  @IsString()
  organizationId: string;

  @ApiProperty()
  @IsString()
  @MinLength(32)
  offerToken: string;
}

export class AppointmentReminderOptOutDto {
  @ApiProperty()
  @IsString()
  organizationId: string;

  @ApiProperty()
  @IsUUID()
  bookingId: string;

  @ApiProperty()
  @IsString()
  @MinLength(32)
  token: string;

  @ApiProperty({ enum: AppointmentReminderChannelDto })
  @IsEnum(AppointmentReminderChannelDto)
  channel: AppointmentReminderChannelDto;
}

export class CheckInAppointmentDto {
  @ApiPropertyOptional({ description: 'Defaults to the current instant.' })
  @IsISO8601()
  @IsOptional()
  checkedInAt?: string;
}

export class CancelAppointmentSeriesDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  fromOccurrenceIndex?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  reason?: string;
}

export class PublicCancelAppointmentSeriesDto extends CancelAppointmentSeriesDto {
  @ApiProperty()
  @IsString()
  organizationId: string;

  @ApiProperty()
  @IsString()
  @MinLength(32)
  manageToken: string;
}

export class ListWaitlistDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;
}
