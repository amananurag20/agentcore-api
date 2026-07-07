import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { OrganizationsService } from '../organizations/organizations.service';
import { SafeUser } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponse } from './types/auth-response';

@Injectable()
export class AuthService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly organizationsService: OrganizationsService,
    private readonly usersService: UsersService,
  ) {}

  async login(input: LoginDto): Promise<AuthResponse> {
    const user = await this.validateUser(input.email, input.password);
    const response = await this.issueAuthResponse(user);

    await this.auditService.record({
      actor: this.toAuthenticatedUser(user),
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
    });

    return response;
  }

  async register(input: RegisterDto): Promise<AuthResponse> {
    const organization = input.orgId
      ? await this.organizationsService.findById(input.orgId)
      : await this.organizationsService.create({
          name: input.orgName ?? `${input.name}'s Organization`,
          plan: 'free',
          deploymentMode: 'saas',
        });

    const user = await this.usersService.create({
      orgId: organization.id,
      email: input.email,
      name: input.name,
      password: input.password,
      roles: ['org_admin'],
    });

    const response = await this.issueAuthResponse(user);

    await this.auditService.record({
      actor: this.toAuthenticatedUser(user),
      action: 'auth.register',
      entityType: 'user',
      entityId: user.id,
      organizationId: organization.id,
      metadata: {
        organizationName: organization.name,
      },
    });

    return response;
  }

  async getProfile(currentUser: AuthenticatedUser): Promise<SafeUser> {
    const user = await this.usersService.findById(currentUser.sub);

    if (!user) {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }

    return user;
  }

  private async validateUser(
    email: string,
    password: string,
  ): Promise<SafeUser> {
    const user = await this.usersService.findByEmail(email);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.usersService.toSafeUser(user);
  }

  private async issueAuthResponse(user: SafeUser): Promise<AuthResponse> {
    const payload = this.toAuthenticatedUser(user);

    return {
      accessToken: await this.jwtService.signAsync(payload, {
        expiresIn: this.getAccessTokenExpiresIn() as '15m',
      }),
      tokenType: 'Bearer',
      expiresIn: this.getAccessTokenExpiresIn(),
      user,
    };
  }

  private toAuthenticatedUser(user: SafeUser): AuthenticatedUser {
    return {
      sub: user.id,
      email: user.email,
      orgId: user.orgId,
      roles: user.roles,
    };
  }

  private getAccessTokenExpiresIn(): string {
    return this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
  }
}
