import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PolicyService } from './policy.service';

describe('PolicyService', () => {
  const organizationProduct = { findFirst: jest.fn() };
  const userProductAccess = { findUnique: jest.fn() };
  const service = new PolicyService({
    organizationProduct,
    userProductAccess,
  } as never);

  const user: AuthenticatedUser = {
    sub: 'user-1',
    email: 'agent@example.com',
    orgId: 'org-1',
    roles: ['agent'],
  };

  beforeEach(() => jest.clearAllMocks());

  it('allows a super admin without an organization entitlement lookup', async () => {
    await expect(
      service.assertProductAccess(
        { ...user, roles: ['super_admin'] },
        'customer_chat',
        'configure',
      ),
    ).resolves.toBeUndefined();
    expect(organizationProduct.findFirst).not.toHaveBeenCalled();
  });

  it('allows an org admin when the product is enabled', async () => {
    organizationProduct.findFirst.mockResolvedValue({ id: 'entitlement-1' });
    await expect(
      service.assertProductAccess(
        { ...user, roles: ['org_admin'] },
        'customer_chat',
        'configure',
      ),
    ).resolves.toBeUndefined();
  });

  it('requires the requested permission for a product-scoped user', async () => {
    organizationProduct.findFirst.mockResolvedValue({ id: 'entitlement-1' });
    userProductAccess.findUnique.mockResolvedValue({
      canUse: true,
      canConfigure: false,
      canManageAgents: false,
    });

    await expect(
      service.assertProductAccess(user, 'customer_chat', 'configure'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
