import { SafeUser } from '../../users/user.entity';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  refreshToken: string;
  expiresIn: string;
  user: SafeUser;
}
