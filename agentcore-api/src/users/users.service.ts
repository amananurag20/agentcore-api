import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole as DbUserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedUser,
  UserRole,
} from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SafeUser } from './user.entity';
import type { ProductAccessDto } from './dto/product-access.dto';

const userInclude = {
  productAccess: true,
  customRoleAssignments: {
    where: { customRole: { isActive: true } },
    include: { customRole: { include: { productAccess: true } } },
  },
} as const;

type DbUser = Prisma.UserGetPayload<{ include: typeof userInclude }>;

interface CreateUserInput {
  orgId: string;
  email: string;
  name: string;
  password: string;
  roles?: UserRole[];
  clearanceLevel?: number;
  productAccess?: ProductAccessDto[];
  customRoleIds?: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async listManagedUsers(currentUser: AuthenticatedUser): Promise<SafeUser[]> {
    const users = await this.prisma.user.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { orgId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
      include: userInclude,
    });

    return users.map((user) => this.toSafeUser(user));
  }

  async assertCanGrantAccess(
    currentUser: AuthenticatedUser,
    orgId: string,
    roles: UserRole[],
    clearanceLevel?: number,
    productAccess?: ProductAccessDto[],
    customRoleIds?: string[],
  ) {
    this.assertAllowedRoles(currentUser, roles);
    await this.assertDelegatedAccess(
      currentUser,
      orgId,
      roles,
      clearanceLevel,
      productAccess,
      customRoleIds,
    );
  }

  async create(input: CreateUserInput): Promise<SafeUser> {
    const email = this.normalizeEmail(input.email);

    try {
      const user = await this.prisma.user.create({
        data: {
          orgId: input.orgId,
          email,
          name: input.name,
          passwordHash: await hash(input.password, 12),
          roles: this.toDbRoles(input.roles?.length ? input.roles : ['user']),
          clearanceLevel: input.clearanceLevel ?? 0,
          productAccess: input.productAccess?.length
            ? {
                create: input.productAccess.map((access) => ({
                  organizationId: input.orgId,
                  productKey: access.productKey,
                  canUse: access.canUse ?? true,
                  canConfigure: access.canConfigure ?? false,
                  canManageAgents: access.canManageAgents ?? false,
                  canManageKnowledge: access.canManageKnowledge ?? false,
                })),
              }
            : undefined,
          customRoleAssignments: input.customRoleIds?.length
            ? {
                create: input.customRoleIds.map((customRoleId) => ({
                  organizationId: input.orgId,
                  customRoleId,
                })),
              }
            : undefined,
        },
        include: userInclude,
      });

      return this.toSafeUser(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }

      throw error;
    }
  }

  async createManagedUser(
    currentUser: AuthenticatedUser,
    input: CreateUserDto,
  ): Promise<SafeUser> {
    const roles: UserRole[] = input.roles?.length ? input.roles : ['user'];
    this.assertAllowedRoles(currentUser, roles);
    const orgId = this.isSuperAdmin(currentUser)
      ? (input.orgId ?? currentUser.orgId)
      : currentUser.orgId;
    await this.assertDelegatedAccess(
      currentUser,
      orgId,
      roles,
      input.clearanceLevel,
      input.productAccess,
      input.customRoleIds,
    );

    const user = await this.create({
      orgId,
      email: input.email,
      name: input.name,
      password: input.password,
      roles,
      clearanceLevel: input.clearanceLevel,
      productAccess: input.productAccess,
      customRoleIds: input.customRoleIds,
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: user.orgId,
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
      metadata: {
        email: user.email,
        roles: user.roles,
      },
    });

    return user;
  }

  async getManagedUser(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeUser> {
    const user = await this.findDbUserForActor(currentUser, id);
    return this.toSafeUser(user);
  }

  async updateManagedUser(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateUserDto,
  ): Promise<SafeUser> {
    const existing = await this.findDbUserForActor(currentUser, id);
    this.assertCanManageTarget(currentUser, existing);

    try {
      const nextOrgId = this.isSuperAdmin(currentUser)
        ? input.orgId
        : undefined;
      const user = await this.prisma.$transaction(
        async (tx) => {
          if (nextOrgId && nextOrgId !== existing.orgId) {
            if (existing.isActive && existing.roles.includes('org_admin')) {
              await this.assertAnotherActiveOrgAdmin(tx, existing.orgId, id);
            }
            await tx.userProductAccess.updateMany({
              where: { userId: id },
              data: { organizationId: nextOrgId },
            });
            await tx.userCustomRole.deleteMany({ where: { userId: id } });
          }
          return tx.user.update({
            where: { id },
            data: {
              email: input.email ? this.normalizeEmail(input.email) : undefined,
              name: input.name,
              orgId: nextOrgId,
            },
            include: userInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      await this.auditService.record({
        actor: currentUser,
        organizationId: user.orgId,
        action: 'user.updated',
        entityType: 'user',
        entityId: user.id,
        metadata: this.removeUndefined({
          email: input.email,
          name: input.name,
          orgId: input.orgId,
        }),
      });

      return this.toSafeUser(user);
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
  }

  async updateManagedUserStatus(
    currentUser: AuthenticatedUser,
    id: string,
    status: 'active' | 'inactive',
  ): Promise<SafeUser> {
    const existing = await this.findDbUserForActor(currentUser, id);
    this.assertCanManageTarget(currentUser, existing);

    if (currentUser.sub === id && status === 'inactive') {
      throw new BadRequestException('You cannot deactivate your own user');
    }

    const user = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUniqueOrThrow({
          where: { id },
          include: userInclude,
        });
        if (status === 'inactive' && target.roles.includes('org_admin')) {
          await this.assertAnotherActiveOrgAdmin(tx, target.orgId, target.id);
        }
        return tx.user.update({
          where: { id },
          data: { isActive: status === 'active' },
          include: userInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: user.orgId,
      action: 'user.status_updated',
      entityType: 'user',
      entityId: user.id,
      metadata: { status },
    });

    return this.toSafeUser(user);
  }

  async updateManagedUserRoles(
    currentUser: AuthenticatedUser,
    id: string,
    roles: UserRole[],
    clearanceLevel?: number,
    productAccess?: ProductAccessDto[],
    customRoleIds?: string[],
  ): Promise<SafeUser> {
    const existing = await this.findDbUserForActor(currentUser, id);
    this.assertCanManageTarget(currentUser, existing);
    this.assertAllowedRoles(currentUser, roles);
    await this.assertDelegatedAccess(
      currentUser,
      existing.orgId,
      roles,
      clearanceLevel,
      productAccess,
      customRoleIds,
    );

    const user = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUniqueOrThrow({
          where: { id },
          include: userInclude,
        });
        if (
          target.roles.includes('org_admin') &&
          !roles.includes('org_admin')
        ) {
          await this.assertAnotherActiveOrgAdmin(tx, target.orgId, target.id);
        }

        if (productAccess !== undefined) {
          await tx.userProductAccess.deleteMany({ where: { userId: id } });
        }
        if (customRoleIds !== undefined) {
          await tx.userCustomRole.deleteMany({ where: { userId: id } });
        }

        return tx.user.update({
          where: { id },
          data: {
            roles: this.toDbRoles(roles),
            clearanceLevel,
            productAccess: productAccess?.length
              ? {
                  create: productAccess.map((access) => ({
                    organizationId: target.orgId,
                    productKey: access.productKey,
                    canUse: access.canUse ?? true,
                    canConfigure: access.canConfigure ?? false,
                    canManageAgents: access.canManageAgents ?? false,
                    canManageKnowledge: access.canManageKnowledge ?? false,
                  })),
                }
              : undefined,
            customRoleAssignments:
              customRoleIds === undefined
                ? undefined
                : customRoleIds.length
                  ? {
                      create: customRoleIds.map((customRoleId) => ({
                        organizationId: target.orgId,
                        customRoleId,
                        assignedById: currentUser.sub,
                      })),
                    }
                  : undefined,
          },
          include: userInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: user.orgId,
      action: 'user.roles_updated',
      entityType: 'user',
      entityId: user.id,
      metadata: {
        roles: user.roles,
        clearanceLevel: user.clearanceLevel,
        productAccess: user.productAccess,
        customRoleIds: user.customRoleAssignments.map(
          (assignment) => assignment.customRoleId,
        ),
      },
    });

    return this.toSafeUser(user);
  }

  async findByEmail(email: string): Promise<DbUser | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
      include: userInclude,
    });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });
    return user ? this.toSafeUser(user) : null;
  }

  private async findDbUserForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<DbUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!this.isSuperAdmin(currentUser) && user.orgId !== currentUser.orgId) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  toSafeUser(user: DbUser): SafeUser {
    return {
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      roles: user.roles,
      clearanceLevel: user.clearanceLevel,
      productAccess: user.productAccess.map((access) => ({
        productKey: access.productKey,
        canUse: access.canUse,
        canConfigure: access.canConfigure,
        canManageAgents: access.canManageAgents,
        canManageKnowledge: access.canManageKnowledge,
      })),
      customRoles: (user.customRoleAssignments ?? []).map(({ customRole }) => ({
        id: customRole.id,
        name: customRole.name,
        clearanceLevel: customRole.clearanceLevel,
        productAccess: customRole.productAccess.map((access) => ({
          productKey: access.productKey,
          canUse: access.canUse,
          canConfigure: access.canConfigure,
          canManageAgents: access.canManageAgents,
          canManageKnowledge: access.canManageKnowledge,
        })),
      })),
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private toDbRoles(roles: UserRole[]): DbUserRole[] {
    return roles;
  }

  private assertAllowedRoles(
    currentUser: AuthenticatedUser,
    roles: UserRole[],
  ) {
    if (!roles.length) {
      throw new BadRequestException('At least one role is required');
    }

    if (!this.isSuperAdmin(currentUser) && roles.includes('super_admin')) {
      throw new ForbiddenException(
        'Organization admins cannot assign super_admin',
      );
    }
    if (
      currentUser.roles.includes('product_admin') &&
      !currentUser.roles.some((role) =>
        ['super_admin', 'org_admin'].includes(role),
      ) &&
      roles.some((role) => !['agent', 'user'].includes(role))
    ) {
      throw new ForbiddenException(
        'Product admins can only assign agent or user roles',
      );
    }
  }

  private async assertDelegatedAccess(
    actor: AuthenticatedUser,
    orgId: string,
    roles: UserRole[],
    clearanceLevel?: number,
    productAccess?: ProductAccessDto[],
    customRoleIds?: string[],
  ) {
    let validatedCustomRoles: Array<{
      clearanceLevel: number;
      productAccess: Array<{ productKey: ProductAccessDto['productKey'] }>;
    }> = [];
    if (customRoleIds?.length) {
      const uniqueRoleIds = [...new Set(customRoleIds)];
      validatedCustomRoles = await this.prisma.customRole.findMany({
        where: {
          id: { in: uniqueRoleIds },
          organizationId: orgId,
          isActive: true,
        },
        include: { productAccess: true },
      });
      if (validatedCustomRoles.length !== uniqueRoleIds.length) {
        throw new BadRequestException('One or more custom roles are invalid');
      }
    }

    if (this.isSuperAdmin(actor)) return;
    if (actor.orgId !== orgId) {
      throw new ForbiddenException(
        'Cannot manage users in another organization',
      );
    }
    if ((clearanceLevel ?? 0) > (actor.clearanceLevel ?? 0)) {
      throw new ForbiddenException(
        'Cannot grant clearance above your own level',
      );
    }
    if (actor.roles.includes('org_admin')) return;
    if (!actor.roles.includes('product_admin')) {
      throw new ForbiddenException('You cannot manage users');
    }

    const manageableProducts = new Set(
      (actor.productAccess ?? [])
        .filter((access) => access.canManageAgents)
        .map((access) => access.productKey),
    );
    const outsideScope = productAccess?.find(
      (access) => !manageableProducts.has(access.productKey),
    );
    if (outsideScope) {
      throw new ForbiddenException(
        `Cannot grant access to ${outsideScope.productKey}`,
      );
    }

    if (validatedCustomRoles.length) {
      for (const role of validatedCustomRoles) {
        if (role.clearanceLevel > (actor.clearanceLevel ?? 0)) {
          throw new ForbiddenException(
            'Cannot assign a role above your clearance',
          );
        }
        const inaccessible = role.productAccess.find(
          (access) => !manageableProducts.has(access.productKey),
        );
        if (inaccessible) {
          throw new ForbiddenException(
            `Cannot assign a role scoped to ${inaccessible.productKey}`,
          );
        }
      }
    }

    if (roles.some((role) => !['agent', 'user'].includes(role))) {
      throw new ForbiddenException('Product admins can only manage members');
    }
  }

  private assertCanManageTarget(actor: AuthenticatedUser, target: DbUser) {
    if (
      actor.roles.includes('product_admin') &&
      !actor.roles.some((role) =>
        ['super_admin', 'org_admin'].includes(role),
      ) &&
      target.roles.some((role) =>
        ['super_admin', 'org_admin', 'product_admin'].includes(role),
      )
    ) {
      throw new ForbiddenException('Product admins can only manage members');
    }
  }

  private async assertAnotherActiveOrgAdmin(
    tx: Prisma.TransactionClient,
    orgId: string,
    excludedUserId: string,
  ) {
    const count = await tx.user.count({
      where: {
        orgId,
        id: { not: excludedUserId },
        isActive: true,
        roles: { has: 'org_admin' },
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Assign another active organization administrator first',
      );
    }
  }

  private handleKnownError(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return;
    }

    if (error.code === 'P2002') {
      throw new ConflictException('A user with this email already exists');
    }

    if (error.code === 'P2003') {
      throw new NotFoundException('Organization not found');
    }
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
