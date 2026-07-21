import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentActionDto } from '../../appointment-booking/dto/appointment-action.dto';
import { IsBoundedJson } from '../../common/validation/is-bounded-json.decorator';

export class CreatePublicCustomerChatConversationDto {
  @ApiPropertyOptional({ example: 'visitor_123' })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ example: 'Ada Visitor' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ example: { pageUrl: 'https://example.com' } })
  @IsObject()
  @IsBoundedJson()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: { name: 'Ada Visitor', email: 'ada@example.com', teamSize: 20 },
  })
  @IsObject()
  @IsBoundedJson()
  @IsOptional()
  leadCapture?: Record<string, unknown>;
}

export class SendPublicCustomerChatMessageDto {
  @ApiProperty({
    example: 'What are your business hours?',
    minLength: 1,
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ description: 'Client-generated idempotency key' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  clientMessageId?: string;

  @ApiPropertyOptional({ type: AppointmentActionDto })
  @ValidateNested()
  @Type(() => AppointmentActionDto)
  @IsOptional()
  appointmentAction?: AppointmentActionDto;
}
