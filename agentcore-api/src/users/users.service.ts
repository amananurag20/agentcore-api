import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, User as DbUser, UserRole as DbUserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import { UserRole } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
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

  async onModuleInit() {
    const existingAdmin = await this.prisma.user.findUnique({
      where: { email: 'admin@agentcore.local' },
    });

    if (existingAdmin) {
      return;
    }

    await this.create({
      orgId: 'org_demo',
      email: 'admin@agentcore.local',
      name: 'AgentCore Admin',
      password: 'Admin@12345',
      roles: ['super_admin', 'org_admin'],
    });
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

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.toSafeUser(user) : null;
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

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
