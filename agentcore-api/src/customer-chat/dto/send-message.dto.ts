import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AppointmentActionDto } from '../../appointment-booking/dto/appointment-action.dto';

export class SendCustomerChatMessageDto {
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
