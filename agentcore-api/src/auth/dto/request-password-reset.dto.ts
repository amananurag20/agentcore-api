import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestPasswordResetDto {
  @ApiProperty({ example: 'admin@agentcore.local' })
  @IsEmail()
  email: string;
}
