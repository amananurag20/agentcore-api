import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { UsersService } from './users.service';

describe('UsersService organization admin invariant', () => {
  const target = {
    id: 'admin-1',
    orgId: 'org-1',
    email: 'admin@example.com',
    name: 'Only Admin',
    passwordHash: 'hash',
    roles: ['org_admin'],
    clearanceLevel: 4,
    productAccess: [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(target),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    },
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(target) },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const audit = { record: jest.fn() };
  const service = new UsersService(audit as never, prisma as never);
  const actor: AuthenticatedUser = {
    sub: 'admin-2',
    email: 'second@example.com',
    orgId: 'org-1',
    roles: ['org_admin'],
  };

  beforeEach(() => jest.clearAllMocks());

  it('refuses to deactivate the final active organization admin', async () => {
    tx.user.findUniqueOrThrow.mockResolvedValue(target);
    tx.user.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue(target);

    await expect(
      service.updateManagedUserStatus(actor, target.id, 'inactive'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
