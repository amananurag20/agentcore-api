import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { AppointmentRecurrenceDto } from './appointment-features.dto';

export enum AppointmentActionTypeDto {
  list_services = 'list_services',
  list_availability = 'list_availability',
  book = 'book',
  reschedule = 'reschedule',
  cancel = 'cancel',
}

export class AppointmentActionDto {
  @ApiProperty({ enum: AppointmentActionTypeDto })
  @IsEnum(AppointmentActionTypeDto)
  action: AppointmentActionTypeDto;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsOptional()
  date?: string;

  @ApiPropertyOptional({ example: '2026-08-01T10:00:00+05:30' })
  @IsISO8601()
  @IsOptional()
  startAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @IsOptional()
  customerName?: string;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  customerPhone?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  partySize?: number;

  @ApiPropertyOptional({ type: AppointmentRecurrenceDto })
  @ValidateNested()
  @Type(() => AppointmentRecurrenceDto)
  @IsOptional()
  recurrence?: AppointmentRecurrenceDto;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(32)
  @IsOptional()
  manageToken?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  applyToFuture?: boolean;
}
