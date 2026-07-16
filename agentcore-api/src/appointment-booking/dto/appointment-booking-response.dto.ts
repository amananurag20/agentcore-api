import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentBookingStatusDto,
  AppointmentServiceStatusDto,
  AppointmentStaffStatusDto,
  AppointmentResourceStatusDto,
} from './appointment-booking.dto';

export class AppointmentServiceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiProperty()
  durationMinutes: number;

  @ApiProperty()
  bufferBeforeMinutes: number;

  @ApiProperty()
  bufferAfterMinutes: number;

  @ApiPropertyOptional()
  priceCents?: number | null;

  @ApiProperty()
  currency: string;

  @ApiProperty()
  maxAttendees: number;

  @ApiPropertyOptional()
  cancellationWindowMinutes?: number | null;

  @ApiPropertyOptional()
  rescheduleWindowMinutes?: number | null;

  @ApiProperty()
  waitlistEnabled: boolean;

  @ApiProperty({ type: [Number] })
  reminderOffsetsMinutes: number[];

  @ApiProperty()
  reminderTemplates: Record<string, string>;

  @ApiProperty({ enum: AppointmentServiceStatusDto })
  status: AppointmentServiceStatusDto;

  @ApiProperty()
  metadata: Record<string, unknown>;
}

export class AppointmentStaffResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiPropertyOptional()
  userId?: string | null;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  email?: string | null;

  @ApiPropertyOptional()
  phone?: string | null;

  @ApiProperty()
  timezone: string;

  @ApiProperty()
  seatsRemaining: number;

  @ApiProperty({ enum: AppointmentStaffStatusDto })
  status: AppointmentStaffStatusDto;

  @ApiProperty({ type: AppointmentServiceResponseDto, isArray: true })
  services: AppointmentServiceResponseDto[];

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiProperty({ type: () => AppointmentResourceResponseDto, isArray: true })
  resources: AppointmentResourceResponseDto[];
}

export class AppointmentResourceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  capacity: number;

  @ApiProperty({ enum: AppointmentResourceStatusDto })
  status: AppointmentResourceStatusDto;

  @ApiProperty()
  metadata: Record<string, unknown>;
}

export class AppointmentAvailabilityResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  staffId: string;

  @ApiProperty()
  dayOfWeek: number;

  @ApiProperty()
  startTime: string;

  @ApiProperty()
  endTime: string;

  @ApiProperty()
  isActive: boolean;
}

export class AppointmentTimeOffResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  staffId: string;

  @ApiProperty()
  startAt: Date;

  @ApiProperty()
  endAt: Date;

  @ApiPropertyOptional()
  reason?: string | null;
}

export class AppointmentSlotResponseDto {
  @ApiProperty()
  staffId: string;

  @ApiProperty()
  staffName: string;

  @ApiProperty()
  startAt: Date;

  @ApiProperty()
  endAt: Date;

  @ApiProperty()
  timezone: string;

  @ApiProperty()
  partySize: number;

  @ApiPropertyOptional()
  checkedInAt?: Date | null;

  @ApiPropertyOptional()
  seriesId?: string | null;

  @ApiPropertyOptional()
  occurrenceIndex?: number | null;
}

export class AppointmentBookingResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  serviceId: string;

  @ApiProperty()
  staffId: string;

  @ApiProperty({ enum: AppointmentBookingStatusDto })
  status: AppointmentBookingStatusDto;

  @ApiProperty()
  customerName: string;

  @ApiPropertyOptional()
  customerEmail?: string | null;

  @ApiPropertyOptional()
  customerPhone?: string | null;

  @ApiProperty()
  startAt: Date;

  @ApiProperty()
  endAt: Date;

  @ApiProperty()
  timezone: string;

  @ApiPropertyOptional()
  notes?: string | null;

  @ApiPropertyOptional()
  cancellationReason?: string | null;

  @ApiProperty()
  metadata: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Returned only when a booking is created. Store it securely for customer self-service.',
  })
  manageToken?: string;
}

export class AppointmentBookingListResponseDto {
  @ApiProperty({ type: AppointmentBookingResponseDto, isArray: true })
  data: AppointmentBookingResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;
}
