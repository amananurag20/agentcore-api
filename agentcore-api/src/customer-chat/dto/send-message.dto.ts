import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SendCustomerChatMessageDto {
  @ApiProperty({ example: 'What are your business hours?', minLength: 1 })
  @IsString()
  @MinLength(1)
  content: string;
}
