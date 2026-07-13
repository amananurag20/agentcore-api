import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import type {
  ProductAction,
  ProductKey,
} from '../common/auth/product-access.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProductAccess(
    user: AuthenticatedUser,
    productKey: ProductKey,
    action: ProductAction,
  ): Promise<void> {
    if (user.roles.includes('super_admin')) return;

    const organizationProduct = await this.prisma.organizationProduct.findFirst(
      {
        where: {
          organizationId: user.orgId,
          product: { key: productKey, status: 'active' },
          status: 'enabled',
        },
        select: { id: true },
      },
    );

    if (!organizationProduct) {
      throw new ForbiddenException(
        'Product is not enabled for this organization',
      );
    }

    if (user.roles.includes('org_admin')) return;

    const directAccess = await this.prisma.userProductAccess.findUnique({
      where: { userId_productKey: { userId: user.sub, productKey } },
    });

    const roleAccess = user.customRoles
      ?.filter((role) =>
        role.productAccess.some((access) => access.productKey === productKey),
      )
      .flatMap((role) => role.productAccess)
      .filter((access) => access.productKey === productKey);

    const allowed = [directAccess, ...(roleAccess ?? [])].some((access) =>
      this.grantsAction(access, action),
    );

    if (!allowed) {
      throw new ForbiddenException(
        `You do not have ${action} access to ${productKey}`,
      );
    }
  }

  getEffectiveClearance(
    user: AuthenticatedUser,
    productKey: ProductKey,
  ): number {
    if (user.roles.includes('super_admin')) return 4;
    if (user.roles.includes('org_admin')) return user.clearanceLevel ?? 4;

    const directGrant = user.productAccess?.some(
      (access) => access.productKey === productKey && access.canUse,
    );
    const directClearance = directGrant ? (user.clearanceLevel ?? 0) : 0;
    const roleClearance = Math.max(
      0,
      ...(user.customRoles ?? [])
        .filter((role) =>
          role.productAccess.some(
            (access) => access.productKey === productKey && access.canUse,
          ),
        )
        .map((role) => role.clearanceLevel),
    );

    return Math.max(directClearance, roleClearance);
  }

  private grantsAction(
    access:
      | {
          canUse: boolean;
          canConfigure: boolean;
          canManageAgents: boolean;
          canManageKnowledge?: boolean;
        }
      | null
      | undefined,
    action: ProductAction,
  ) {
    if (!access) return false;
    if (action === 'use') return access.canUse;
    if (action === 'configure') return access.canConfigure;
    if (action === 'manage_agents') return access.canManageAgents;
    return access.canManageKnowledge ?? access.canConfigure;
  }
}
