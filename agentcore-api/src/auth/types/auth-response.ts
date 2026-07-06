import { SafeUser } from '../../users/user.entity';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: SafeUser;
}
