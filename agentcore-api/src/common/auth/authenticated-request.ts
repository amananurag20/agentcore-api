import { Request } from 'express';

export type UserRole = 'super_admin' | 'org_admin' | 'agent' | 'user';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  orgId: string;
  roles: UserRole[];
}

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
};
