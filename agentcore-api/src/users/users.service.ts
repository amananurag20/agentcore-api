import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User as DbUser, UserRole as DbUserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import {
  AuthenticatedUser,
  UserRole,
} from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SafeUser, User } from './user.entity';

interface CreateUserInput {
  orgId: string;
  email: string;
  name: string;
  password: string;
  roles?: UserRole[];
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async listManagedUsers(currentUser: AuthenticatedUser): Promise<SafeUser[]> {
    const users = await this.prisma.user.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { orgId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
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
        },
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

    return this.create({
      orgId: this.isSuperAdmin(currentUser)
        ? (input.orgId ?? currentUser.orgId)
        : currentUser.orgId,
      email: input.email,
      name: input.name,
      password: input.password,
      roles,
    });
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
    await this.findDbUserForActor(currentUser, id);

    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: {
          email: input.email ? this.normalizeEmail(input.email) : undefined,
          name: input.name,
          orgId: this.isSuperAdmin(currentUser) ? input.orgId : undefined,
        },
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

    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive: status === 'active' },
    });

    return this.toSafeUser(user);
  }

  async updateManagedUserRoles(
    currentUser: AuthenticatedUser,
    id: string,
    roles: UserRole[],
  ): Promise<SafeUser> {
    await this.findDbUserForActor(currentUser, id);
    this.assertAllowedRoles(currentUser, roles);

    const user = await this.prisma.user.update({
      where: { id },
      data: { roles: this.toDbRoles(roles) },
    });

    return this.toSafeUser(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.toSafeUser(user) : null;
  }

  private async findDbUserForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<DbUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });

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

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
