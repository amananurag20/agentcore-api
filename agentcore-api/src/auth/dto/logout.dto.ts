import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Refresh token to revoke. If omitted, only the current access token remains stateless.',
  })
  @IsString()
  @MinLength(24)
  @IsOptional()
  refreshToken?: string;
}
