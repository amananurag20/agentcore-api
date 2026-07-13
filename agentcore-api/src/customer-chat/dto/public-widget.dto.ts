import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentActionDto } from '../../appointment-booking/dto/appointment-action.dto';

export class CreatePublicCustomerChatConversationDto {
  @ApiPropertyOptional({ example: 'visitor_123' })
  @IsString()
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ example: 'Ada Visitor' })
  @IsString()
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ example: { pageUrl: 'https://example.com' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class SendPublicCustomerChatMessageDto {
  @ApiProperty({ example: 'What are your business hours?', minLength: 1 })
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ type: AppointmentActionDto })
  @ValidateNested()
  @Type(() => AppointmentActionDto)
  @IsOptional()
  appointmentAction?: AppointmentActionDto;
}
