import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ minLength: 24 })
  @IsString()
  @MinLength(24)
  refreshToken: string;
}
