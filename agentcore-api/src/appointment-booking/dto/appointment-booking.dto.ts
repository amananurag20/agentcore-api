import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AppointmentRecurrenceDto } from './appointment-features.dto';

export enum AppointmentServiceStatusDto {
  active = 'active',
  inactive = 'inactive',
}

export enum AppointmentStaffStatusDto {
  active = 'active',
  inactive = 'inactive',
}

export enum AppointmentResourceStatusDto {
  active = 'active',
  inactive = 'inactive',
}

export enum AppointmentBookingStatusDto {
  pending = 'pending',
  confirmed = 'confirmed',
  cancelled = 'cancelled',
  completed = 'completed',
  no_show = 'no_show',
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAppointmentServiceDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Dental Consultation', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'Initial consultation with a specialist.' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 30, minimum: 5, maximum: 1440 })
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes: number;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 240 })
  @IsInt()
  @Min(0)
  @Max(240)
  @IsOptional()
  bufferBeforeMinutes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 240 })
  @IsInt()
  @Min(0)
  @Max(240)
  @IsOptional()
  bufferAfterMinutes?: number;

  @ApiPropertyOptional({ example: 5000, minimum: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  priceCents?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  maxAttendees?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 43200, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  cancellationWindowMinutes?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 43200, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  rescheduleWindowMinutes?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  waitlistEnabled?: boolean;

  @ApiPropertyOptional({ type: [Number], example: [1440, 60] })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(525600, { each: true })
  @IsOptional()
  reminderOffsetsMinutes?: number[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  reminderTemplates?: Record<string, string>;

  @ApiPropertyOptional({ enum: AppointmentServiceStatusDto })
  @IsEnum(AppointmentServiceStatusDto)
  @IsOptional()
  status?: AppointmentServiceStatusDto;

  @ApiPropertyOptional({ example: { color: '#116466' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class UpdateAppointmentServiceDto {
  @ApiPropertyOptional({ example: 'Dental Consultation' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Initial consultation with a specialist.' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ example: 30, minimum: 5, maximum: 1440 })
  @IsInt()
  @Min(5)
  @Max(1440)
  @IsOptional()
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 240 })
  @IsInt()
  @Min(0)
  @Max(240)
  @IsOptional()
  bufferBeforeMinutes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 240 })
  @IsInt()
  @Min(0)
  @Max(240)
  @IsOptional()
  bufferAfterMinutes?: number;

  @ApiPropertyOptional({ example: 5000, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  priceCents?: number | null;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  maxAttendees?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 43200, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  cancellationWindowMinutes?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 43200, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  rescheduleWindowMinutes?: number | null;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  waitlistEnabled?: boolean;

  @ApiPropertyOptional({ type: [Number] })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(525600, { each: true })
  @IsOptional()
  reminderOffsetsMinutes?: number[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  reminderTemplates?: Record<string, string>;

  @ApiPropertyOptional({ enum: AppointmentServiceStatusDto })
  @IsEnum(AppointmentServiceStatusDto)
  @IsOptional()
  status?: AppointmentServiceStatusDto;

  @ApiPropertyOptional({ example: { color: '#116466' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class CreateAppointmentStaffDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  userId?: string;

  @ApiProperty({ example: 'Dr. Ada Lovelace', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ enum: AppointmentStaffStatusDto })
  @IsEnum(AppointmentStaffStatusDto)
  @IsOptional()
  status?: AppointmentStaffStatusDto;

  @ApiPropertyOptional({
    example: ['ecfdf154-2b72-477e-b286-43120fe69ead'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @IsOptional()
  serviceIds?: string[];

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  resourceIds?: string[];

  @ApiPropertyOptional({ example: { room: 'A1' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class UpdateAppointmentStaffDto {
  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  userId?: string | null;

  @ApiPropertyOptional({ example: 'Dr. Ada Lovelace' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'ada@example.com', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ example: '+15551234567', nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  phone?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ enum: AppointmentStaffStatusDto })
  @IsEnum(AppointmentStaffStatusDto)
  @IsOptional()
  status?: AppointmentStaffStatusDto;

  @ApiPropertyOptional({
    example: ['ecfdf154-2b72-477e-b286-43120fe69ead'],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  serviceIds?: string[];

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  resourceIds?: string[];

  @ApiPropertyOptional({ example: { room: 'A1' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class CreateAppointmentResourceDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Consultation Room A' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'room' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, example: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ enum: AppointmentResourceStatusDto })
  @IsEnum(AppointmentResourceStatusDto)
  @IsOptional()
  status?: AppointmentResourceStatusDto;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class UpdateAppointmentResourceDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ enum: AppointmentResourceStatusDto })
  @IsEnum(AppointmentResourceStatusDto)
  @IsOptional()
  status?: AppointmentResourceStatusDto;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class SetServiceResourceDto {
  @ApiProperty()
  @IsUUID()
  resourceId: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  quantity?: number;
}

export class SetStaffAvailabilityDto {
  @ApiProperty({ example: 1, minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '09:00' })
  @Matches(timePattern)
  startTime: string;

  @ApiProperty({ example: '17:30' })
  @Matches(timePattern)
  endTime: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateStaffTimeOffDto {
  @ApiProperty({ example: '2026-08-01T09:00:00.000Z' })
  @IsISO8601()
  startAt: string;

  @ApiProperty({ example: '2026-08-01T17:00:00.000Z' })
  @IsISO8601()
  endAt: string;

  @ApiPropertyOptional({ example: 'Holiday' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ListAvailabilityDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  serviceId: string;

  @ApiProperty({ example: '2026-08-01' })
  @Matches(datePattern)
  date: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description:
      'Timezone in which the requested calendar date is interpreted.',
  })
  @IsString()
  @IsOptional()
  timezone?: string;
}

export class PublicListAppointmentServicesDto {
  @ApiProperty({ example: 'org_demo' })
  @IsString()
  organizationId: string;
}

export class PublicListAvailabilityDto {
  @ApiProperty({ example: 'org_demo' })
  @IsString()
  organizationId: string;

  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  serviceId: string;

  @ApiProperty({ example: '2026-08-01' })
  @Matches(datePattern)
  date: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description:
      'Timezone in which the requested calendar date is interpreted.',
  })
  @IsString()
  @IsOptional()
  timezone?: string;
}

export class CreateAppointmentBookingDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  serviceId: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiProperty({ example: 'Ada Customer' })
  @IsString()
  @MinLength(2)
  customerName: string;

  @ApiPropertyOptional({ example: 'customer@example.com' })
  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  customerPhone?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  partySize?: number;

  @ApiProperty({ example: '2026-08-01T10:00:00.000Z' })
  @IsISO8601()
  startAt: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ example: 'Please call before the appointment.' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ example: { source: 'widget' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ type: AppointmentRecurrenceDto })
  @ValidateNested()
  @Type(() => AppointmentRecurrenceDto)
  @IsOptional()
  recurrence?: AppointmentRecurrenceDto;
}

export class PublicCreateAppointmentBookingDto {
  @ApiProperty({ example: 'org_demo' })
  @IsString()
  organizationId: string;

  @ApiProperty({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  serviceId: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiProperty({ example: 'Ada Customer' })
  @IsString()
  @MinLength(2)
  customerName: string;

  @ApiPropertyOptional({ example: 'customer@example.com' })
  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsString()
  @IsOptional()
  customerPhone?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  partySize?: number;

  @ApiProperty({ example: '2026-08-01T10:00:00.000Z' })
  @IsISO8601()
  startAt: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ example: 'Please call before the appointment.' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ example: { source: 'widget' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ type: AppointmentRecurrenceDto })
  @ValidateNested()
  @Type(() => AppointmentRecurrenceDto)
  @IsOptional()
  recurrence?: AppointmentRecurrenceDto;
}

export class ListAppointmentBookingsDto {
  @ApiPropertyOptional({ example: 'org_demo' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ enum: AppointmentBookingStatusDto })
  @IsEnum(AppointmentBookingStatusDto)
  @IsOptional()
  status?: AppointmentBookingStatusDto;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsISO8601()
  @IsOptional()
  to?: string;

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

export class RescheduleAppointmentBookingDto {
  @ApiPropertyOptional({ example: 'ecfdf154-2b72-477e-b286-43120fe69ead' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiProperty({ example: '2026-08-02T10:00:00.000Z' })
  @IsISO8601()
  startAt: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    description:
      'For recurring bookings, apply the same time/staff shift to this and all future occurrences.',
  })
  @IsBoolean()
  @IsOptional()
  applyToFuture?: boolean;
}

export class CancelAppointmentBookingDto {
  @ApiPropertyOptional({ example: 'Customer requested cancellation.' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class PublicRescheduleAppointmentBookingDto extends RescheduleAppointmentBookingDto {
  @ApiProperty({ example: 'org_demo' })
  @IsString()
  organizationId: string;

  @ApiProperty({
    description: 'One-time management secret returned at booking creation.',
  })
  @IsString()
  @MinLength(32)
  manageToken: string;
}

export class PublicCancelAppointmentBookingDto extends CancelAppointmentBookingDto {
  @ApiProperty({ example: 'org_demo' })
  @IsString()
  organizationId: string;

  @ApiProperty({
    description: 'One-time management secret returned at booking creation.',
  })
  @IsString()
  @MinLength(32)
  manageToken: string;
}

export class UpdateAppointmentBookingStatusDto {
  @ApiProperty({ enum: AppointmentBookingStatusDto })
  @IsEnum(AppointmentBookingStatusDto)
  status: AppointmentBookingStatusDto;
}
