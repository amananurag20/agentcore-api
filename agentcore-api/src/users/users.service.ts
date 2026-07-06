import { ConflictException, Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { User, SafeUser } from './user.entity';
import { UserRole } from '../common/auth/authenticated-request';

interface CreateUserInput {
  orgId: string;
  email: string;
  name: string;
  password: string;
  roles?: UserRole[];
}

@Injectable()
export class UsersService {
  private readonly users = new Map<string, User>();

  async onModuleInit() {
    if (this.users.size > 0) {
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

    if (this.users.has(email)) {
      throw new ConflictException('A user with this email already exists');
    }

    const now = new Date();
    const user: User = {
      id: randomUUID(),
      orgId: input.orgId,
      email,
      name: input.name,
      passwordHash: await hash(input.password, 12),
      roles: input.roles?.length ? input.roles : ['user'],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(email, user);
    return this.toSafeUser(user);
  }

  findByEmail(email: string): User | undefined {
    return this.users.get(this.normalizeEmail(email));
  }

  findById(id: string): SafeUser | undefined {
    const user = [...this.users.values()].find((item) => item.id === id);
    return user ? this.toSafeUser(user) : undefined;
  }

  toSafeUser(user: User): SafeUser {
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

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
