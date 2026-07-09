import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ minLength: 24 })
  @IsString()
  @MinLength(24)
  token: string;

  @ApiProperty({ example: 'NewStrongPassword@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}
