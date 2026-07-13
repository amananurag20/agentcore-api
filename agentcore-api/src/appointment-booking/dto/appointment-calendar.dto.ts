import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export enum AppointmentCalendarProviderDto {
  google = 'google',
  microsoft = 'microsoft',
}

export class ConnectAppointmentCalendarDto {
  @ApiProperty()
  @IsUUID()
  staffId: string;

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
