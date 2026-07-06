import { UserRole } from '../common/auth/authenticated-request';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  passwordHash: string;
  roles: UserRole[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SafeUser = Omit<User, 'passwordHash'>;
