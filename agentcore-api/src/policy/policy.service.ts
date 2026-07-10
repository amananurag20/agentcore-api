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

    const access = await this.prisma.userProductAccess.findUnique({
      where: { userId_productKey: { userId: user.sub, productKey } },
    });

    const allowed =
      access &&
      (action === 'use'
        ? access.canUse
        : action === 'configure'
          ? access.canConfigure
          : access.canManageAgents);

    if (!allowed) {
      throw new ForbiddenException(
        `You do not have ${action} access to ${productKey}`,
      );
    }
  }
}
