import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @ApiProperty({ minLength: 24 })
  @IsString()
  @MinLength(24)
  token: string;

  @ApiProperty({ example: 'Invited User', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ example: 'StrongPassword@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({
    description: 'Optional user agent captured by clients.',
  })
  @IsString()
  @IsOptional()
  userAgent?: string;
}
