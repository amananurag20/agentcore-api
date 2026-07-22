import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export enum AppointmentCalendarProviderDto {
  google = 'google',
  microsoft = 'microsoft',
}

export enum AppointmentCalendarConnectionScopeDto {
  organization = 'organization',
  staff = 'staff',
}

export class ConnectAppointmentCalendarDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    enum: AppointmentCalendarConnectionScopeDto,
    default: AppointmentCalendarConnectionScopeDto.organization,
  })
  @IsEnum(AppointmentCalendarConnectionScopeDto)
  @IsOptional()
  scope?: AppointmentCalendarConnectionScopeDto;

  @ApiPropertyOptional()
  @ValidateIf(
    (input: ConnectAppointmentCalendarDto) =>
      input.scope === AppointmentCalendarConnectionScopeDto.staff,
  )
  @IsUUID()
  staffId?: string;

  @ApiProperty({ enum: AppointmentCalendarProviderDto })
  @IsEnum(AppointmentCalendarProviderDto)
  provider: AppointmentCalendarProviderDto;

  @ApiPropertyOptional({ default: 'primary' })
  @IsString()
  @IsOptional()
  calendarId?: string;
}

export class ListAppointmentCalendarConnectionsDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  staffId?: string;
}
