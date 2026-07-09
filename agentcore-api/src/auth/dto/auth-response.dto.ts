import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from './user-response.dto';

export class AuthResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.signature',
  })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({
    example: 'opaque-refresh-token-value',
    description:
      'Opaque refresh token. Store securely on the client and rotate through /auth/refresh.',
  })
  refreshToken: string;

  @ApiProperty({ example: '15m' })
  expiresIn: string;

  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;
}
