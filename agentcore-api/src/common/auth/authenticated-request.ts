import { Request } from 'express';
import type { ProductAccessGrant } from './product-access.types';

export type UserRole =
  'super_admin' | 'org_admin' | 'product_admin' | 'agent' | 'user';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  orgId: string;
  roles: UserRole[];
  clearanceLevel?: number;
  productAccess?: ProductAccessGrant[];
  customRoles?: CustomRoleGrant[];
  principalType?: 'user' | 'service';
  servicePrincipalId?: string;
  serviceProductKey?: ProductAccessGrant['productKey'];
  forwardedUserId?: string;
}

export interface CustomRoleGrant {
  id: string;
  name: string;
  clearanceLevel: number;
  productAccess: ProductAccessGrant[];
}

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
};
