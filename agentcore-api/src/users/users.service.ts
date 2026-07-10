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

type DbUser = Prisma.UserGetPayload<{ include: { productAccess: true } }>;

interface CreateUserInput {
  orgId: string;
  email: string;
  name: string;
  password: string;
  roles?: UserRole[];
  clearanceLevel?: number;
  productAccess?: ProductAccessDto[];
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
      include: { productAccess: true },
    });

    return users.map((user) => this.toSafeUser(user));
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
                })),
              }
            : undefined,
        },
        include: { productAccess: true },
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

    const user = await this.create({
      orgId: this.isSuperAdmin(currentUser)
        ? (input.orgId ?? currentUser.orgId)
        : currentUser.orgId,
      email: input.email,
      name: input.name,
      password: input.password,
      roles,
      clearanceLevel: input.clearanceLevel,
      productAccess: input.productAccess,
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
          }
          return tx.user.update({
            where: { id },
            data: {
              email: input.email ? this.normalizeEmail(input.email) : undefined,
              name: input.name,
              orgId: nextOrgId,
            },
            include: { productAccess: true },
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
    await this.findDbUserForActor(currentUser, id);

    if (currentUser.sub === id && status === 'inactive') {
      throw new BadRequestException('You cannot deactivate your own user');
    }

    const user = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUniqueOrThrow({
          where: { id },
          include: { productAccess: true },
        });
        if (status === 'inactive' && target.roles.includes('org_admin')) {
          await this.assertAnotherActiveOrgAdmin(tx, target.orgId, target.id);
        }
        return tx.user.update({
          where: { id },
          data: { isActive: status === 'active' },
          include: { productAccess: true },
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
  ): Promise<SafeUser> {
    await this.findDbUserForActor(currentUser, id);
    this.assertAllowedRoles(currentUser, roles);

    const user = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUniqueOrThrow({
          where: { id },
          include: { productAccess: true },
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
                  })),
                }
              : undefined,
          },
          include: { productAccess: true },
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
      },
    });

    return this.toSafeUser(user);
  }

  async findByEmail(email: string): Promise<DbUser | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
      include: { productAccess: true },
    });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { productAccess: true },
    });
    return user ? this.toSafeUser(user) : null;
  }

  private async findDbUserForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<DbUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { productAccess: true },
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
