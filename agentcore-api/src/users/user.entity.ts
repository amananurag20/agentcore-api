import { UserRole } from '../common/auth/authenticated-request';
import type { ProductAccessGrant } from '../common/auth/product-access.types';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  passwordHash: string;
  roles: UserRole[];
  clearanceLevel: number;
  productAccess: ProductAccessGrant[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SafeUser = Omit<User, 'passwordHash'>;
