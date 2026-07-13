import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import type { ProductAccessDto } from '../users/dto/product-access.dto';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
} from './dto/upsert-custom-role.dto';

const roleInclude = {
  productAccess: true,
  _count: { select: { assignments: true } },
} as const;

@Injectable()
export class CustomRolesService {
  constructor(
    private readonly auditService: AuditService,
    private readonly policyService: PolicyService,
    private readonly prisma: PrismaService,
  ) {}

  async list(currentUser: AuthenticatedUser, organizationId?: string) {
    const orgId = this.resolveOrganizationId(currentUser, organizationId);
    return this.prisma.customRole.findMany({
      where: { organizationId: orgId },
      include: roleInclude,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async get(currentUser: AuthenticatedUser, id: string) {
    return this.findForActor(currentUser, id);
  }

  async create(currentUser: AuthenticatedUser, input: CreateCustomRoleDto) {
    const organizationId = this.resolveOrganizationId(currentUser, input.orgId);
    await this.assertCanDefineRole(
      currentUser,
      organizationId,
      input.clearanceLevel,
      input.productAccess,
    );

    try {
      const role = await this.prisma.customRole.create({
        data: {
          organizationId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          clearanceLevel: input.clearanceLevel,
          isTemplate: currentUser.roles.includes('super_admin')
            ? (input.isTemplate ?? false)
            : false,
          createdById: currentUser.sub,
          productAccess: {
            create: this.toProductAccessData(input.productAccess),
          },
        },
        include: roleInclude,
      });

      await this.auditService.record({
        actor: currentUser,
        organizationId,
        action: 'custom_role.created',
        entityType: 'custom_role',
        entityId: role.id,
        metadata: this.auditMetadata(role),
      });
      return role;
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
  }

  async update(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateCustomRoleDto,
  ) {
    const existing = await this.findForActor(currentUser, id);
    if (existing.isTemplate && !currentUser.roles.includes('super_admin')) {
      throw new ForbiddenException(
        'Template roles can only be edited by a super admin',
      );
    }

    const productAccess = input.productAccess ?? existing.productAccess;
    const clearanceLevel = input.clearanceLevel ?? existing.clearanceLevel;
    await this.assertCanDefineRole(
      currentUser,
      existing.organizationId,
      clearanceLevel,
      productAccess,
    );

    try {
      const role = await this.prisma.$transaction(async (tx) => {
        if (input.productAccess) {
          await tx.customRoleProductAccess.deleteMany({
            where: { customRoleId: id },
          });
        }
        if (input.isActive === false) {
          await tx.userCustomRole.deleteMany({
            where: { customRoleId: id },
          });
        }
        return tx.customRole.update({
          where: { id },
          data: {
            name: input.name?.trim(),
            description:
              input.description === undefined
                ? undefined
                : input.description.trim() || null,
            clearanceLevel: input.clearanceLevel,
            isActive: input.isActive,
            productAccess: input.productAccess
              ? { create: this.toProductAccessData(input.productAccess) }
              : undefined,
          },
          include: roleInclude,
        });
      });

      await this.auditService.record({
        actor: currentUser,
        organizationId: role.organizationId,
        action: 'custom_role.updated',
        entityType: 'custom_role',
        entityId: role.id,
        metadata: this.auditMetadata(role),
      });
      return role;
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
  }

  async archive(currentUser: AuthenticatedUser, id: string) {
    const existing = await this.findForActor(currentUser, id);
    if (existing.isTemplate && !currentUser.roles.includes('super_admin')) {
      throw new ForbiddenException(
        'Template roles can only be archived by a super admin',
      );
    }
    await this.assertCanDefineRole(
      currentUser,
      existing.organizationId,
      existing.clearanceLevel,
      existing.productAccess,
    );
    const role = await this.prisma.$transaction(async (tx) => {
      await tx.userCustomRole.deleteMany({ where: { customRoleId: id } });
      return tx.customRole.update({
        where: { id },
        data: { isActive: false },
        include: roleInclude,
      });
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: role.organizationId,
      action: 'custom_role.archived',
      entityType: 'custom_role',
      entityId: role.id,
      metadata: { name: role.name },
    });
    return role;
  }

  private async findForActor(currentUser: AuthenticatedUser, id: string) {
    const role = await this.prisma.customRole.findUnique({
      where: { id },
      include: roleInclude,
    });
    if (
      !role ||
      (!currentUser.roles.includes('super_admin') &&
        role.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Custom role not found');
    }
    return role;
  }

  private async assertCanDefineRole(
    actor: AuthenticatedUser,
    organizationId: string,
    clearanceLevel: number,
    productAccess: ProductAccessDto[],
  ) {
    if (!productAccess.length) {
      throw new BadRequestException(
        'A custom role must unlock at least one product',
      );
    }
    const duplicate = productAccess.find(
      (entry, index) =>
        productAccess.findIndex(
          (item) => item.productKey === entry.productKey,
        ) !== index,
    );
    if (duplicate) {
      throw new BadRequestException(
        `Duplicate product access: ${duplicate.productKey}`,
      );
    }

    const enabled = await this.prisma.organizationProduct.findMany({
      where: {
        organizationId,
        status: 'enabled',
        product: {
          key: { in: productAccess.map((entry) => entry.productKey) },
        },
      },
      select: { product: { select: { key: true } } },
    });
    const enabledKeys = new Set(enabled.map((entry) => entry.product.key));
    const unavailable = productAccess.find(
      (entry) => !enabledKeys.has(entry.productKey),
    );
    if (unavailable) {
      throw new BadRequestException(
        `Product ${unavailable.productKey} is not enabled for this organization`,
      );
    }

    if (
      actor.roles.includes('super_admin') ||
      actor.roles.includes('org_admin')
    ) {
      if (
        !actor.roles.includes('super_admin') &&
        clearanceLevel > (actor.clearanceLevel ?? 0)
      ) {
        throw new ForbiddenException(
          'Cannot grant clearance above your own level',
        );
      }
      return;
    }

    if (
      !actor.roles.includes('product_admin') ||
      actor.orgId !== organizationId
    ) {
      throw new ForbiddenException('You cannot manage custom roles');
    }
    for (const access of productAccess) {
      await this.policyService.assertProductAccess(
        actor,
        access.productKey,
        'manage_agents',
      );
      const actorClearance = this.policyService.getEffectiveClearance(
        actor,
        access.productKey,
      );
      if (clearanceLevel > actorClearance) {
        throw new ForbiddenException(
          `Cannot grant clearance ${clearanceLevel} for ${access.productKey}`,
        );
      }
    }
  }

  private resolveOrganizationId(actor: AuthenticatedUser, requested?: string) {
    if (requested && actor.roles.includes('super_admin')) return requested;
    if (requested && requested !== actor.orgId) {
      throw new ForbiddenException(
        'Cannot manage roles in another organization',
      );
    }
    return requested ?? actor.orgId;
  }

  private toProductAccessData(access: ProductAccessDto[]) {
    return access.map((entry) => ({
      productKey: entry.productKey,
      canUse: entry.canUse ?? true,
      canConfigure: entry.canConfigure ?? false,
      canManageAgents: entry.canManageAgents ?? false,
      canManageKnowledge: entry.canManageKnowledge ?? false,
    }));
  }

  private auditMetadata(role: {
    name: string;
    clearanceLevel: number;
    isTemplate: boolean;
    isActive: boolean;
    productAccess: unknown;
  }) {
    return {
      name: role.name,
      clearanceLevel: role.clearanceLevel,
      isTemplate: role.isTemplate,
      isActive: role.isActive,
      productAccess: role.productAccess,
    };
  }

  private handleKnownError(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A custom role with this name already exists',
      );
    }
  }
}
