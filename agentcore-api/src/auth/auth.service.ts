import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { compare, hash as hashPassword } from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { APPLICATION_DEFAULTS } from '../config/application-defaults';
import {
  AuthenticatedUser,
  UserRole,
} from '../common/auth/authenticated-request';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SafeUser } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthResponse } from './types/auth-response';

interface AuthRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly organizationsService: OrganizationsService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async login(
    input: LoginDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponse> {
    const user = await this.validateUser(input.email, input.password);
    const response = await this.issueAuthResponse(user, context);

    await this.auditService.record({
      actor: this.toAuthenticatedUser(user),
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
    });

    return response;
  }

  async register(
    input: RegisterDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponse> {
    if (!input.orgId) {
      throw new BadRequestException(
        'orgId is required. New organizations must be created with a first administrator.',
      );
    }
    const organization = await this.organizationsService.findById(input.orgId);

    const user = await this.usersService.create({
      orgId: organization.id,
      email: input.email,
      name: input.name,
      password: input.password,
      roles: ['org_admin'],
    });

    const response = await this.issueAuthResponse(user, context);

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

  async refresh(
    input: RefreshTokenDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponse> {
    const tokenHash = this.hashToken(input.refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!session.user.isActive) {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }

    const user = await this.usersService.findById(session.userId);
    if (!user) {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }
    const refreshToken = this.generateToken();
    const refreshTokenHash = this.hashToken(refreshToken);
    const expiresAt = this.getRefreshTokenExpiresAt();

    const replacement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.authSession.create({
        data: {
          userId: user.id,
          organizationId: user.orgId,
          tokenHash: refreshTokenHash,
          userAgent: context.userAgent ?? session.userAgent,
          ipAddress: context.ipAddress ?? session.ipAddress,
          expiresAt,
        },
      });

      await tx.authSession.update({
        where: { id: session.id },
        data: {
          revokedAt: new Date(),
          replacedById: created.id,
        },
      });

      return created;
    });

    await this.auditService.record({
      actor: this.toAuthenticatedUser(user),
      action: 'auth.refresh',
      entityType: 'auth_session',
      entityId: replacement.id,
    });

    return {
      accessToken: await this.issueAccessToken(user),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.getAccessTokenExpiresIn(),
      user,
    };
  }

  async logout(currentUser: AuthenticatedUser, refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.authSession.updateMany({
        where: {
          tokenHash: this.hashToken(refreshToken),
          userId: currentUser.sub,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }

    await this.auditService.record({
      actor: currentUser,
      action: 'auth.logout',
      entityType: 'user',
      entityId: currentUser.sub,
    });

    return { loggedOut: true };
  }

  async logoutAll(currentUser: AuthenticatedUser) {
    await this.prisma.authSession.updateMany({
      where: {
        userId: currentUser.sub,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    await this.auditService.record({
      actor: currentUser,
      action: 'auth.logout_all',
      entityType: 'user',
      entityId: currentUser.sub,
    });

    return { loggedOut: true };
  }

  async requestPasswordReset(input: RequestPasswordResetDto) {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      return { requested: true };
    }

    const token = await this.createOneTimeToken({
      organizationId: user.orgId,
      userId: user.id,
      email: user.email,
      type: 'password_reset',
      expiresAt: this.getPasswordResetExpiresAt(),
    });

    await this.auditService.record({
      actor: null,
      organizationId: user.orgId,
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
    });

    return {
      requested: true,
      ...(this.shouldExposeDevToken() ? { devResetToken: token.token } : {}),
      expiresAt: token.expiresAt,
    };
  }

  async resetPassword(input: ResetPasswordDto) {
    const record = await this.consumeOneTimeToken({
      token: input.token,
      type: 'password_reset',
    });

    if (!record.userId) {
      throw new BadRequestException('Invalid password reset token');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(input.password, 12),
          isActive: true,
        },
      }),
      this.prisma.authSession.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.auditService.record({
      actor: null,
      organizationId: record.organizationId,
      action: 'auth.password_reset_completed',
      entityType: 'user',
      entityId: record.userId,
    });

    return { reset: true };
  }

  async createInvite(currentUser: AuthenticatedUser, input: CreateInviteDto) {
    const organizationId = this.resolveOrganizationId(currentUser, input.orgId);
    const roles: UserRole[] = input.roles?.length ? input.roles : ['user'];
    this.assertAllowedRoles(currentUser, roles);
    await this.usersService.assertCanGrantAccess(
      currentUser,
      organizationId,
      roles,
      input.clearanceLevel,
      input.productAccess,
      input.customRoleIds,
    );

    const email = this.normalizeEmail(input.email);
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        productAccess: true,
        customRoleAssignments: {
          where: { customRole: { isActive: true } },
          include: { customRole: { include: { productAccess: true } } },
        },
      },
    });

    if (user && user.orgId !== organizationId) {
      throw new ConflictException('A user with this email already exists');
    }

    if (user?.isActive) {
      throw new ConflictException(
        'User is already active. Use password reset instead.',
      );
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          orgId: organizationId,
          email,
          name: input.name ?? email.split('@')[0],
          passwordHash: await hashPassword(this.generateToken(), 12),
          roles: roles,
          clearanceLevel: input.clearanceLevel ?? 0,
          productAccess: input.productAccess?.length
            ? {
                create: input.productAccess.map((access) => ({
                  organizationId,
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
                  organizationId,
                  customRoleId,
                  assignedById: currentUser.sub,
                })),
              }
            : undefined,
          isActive: false,
        },
        include: {
          productAccess: true,
          customRoleAssignments: {
            where: { customRole: { isActive: true } },
            include: { customRole: { include: { productAccess: true } } },
          },
        },
      });
    } else {
      user = await this.prisma.$transaction(async (tx) => {
        if (input.productAccess !== undefined) {
          await tx.userProductAccess.deleteMany({
            where: { userId: user!.id },
          });
        }
        if (input.customRoleIds !== undefined) {
          await tx.userCustomRole.deleteMany({ where: { userId: user!.id } });
        }
        return tx.user.update({
          where: { id: user!.id },
          data: {
            name: input.name ?? user!.name,
            roles,
            clearanceLevel: input.clearanceLevel,
            productAccess: input.productAccess?.length
              ? {
                  create: input.productAccess.map((access) => ({
                    organizationId,
                    productKey: access.productKey,
                    canUse: access.canUse ?? true,
                    canConfigure: access.canConfigure ?? false,
                    canManageAgents: access.canManageAgents ?? false,
                    canManageKnowledge: access.canManageKnowledge ?? false,
                  })),
                }
              : undefined,
            customRoleAssignments:
              input.customRoleIds === undefined
                ? undefined
                : input.customRoleIds.length
                  ? {
                      create: input.customRoleIds.map((customRoleId) => ({
                        organizationId,
                        customRoleId,
                        assignedById: currentUser.sub,
                      })),
                    }
                  : undefined,
            isActive: false,
          },
          include: {
            productAccess: true,
            customRoleAssignments: {
              where: { customRole: { isActive: true } },
              include: { customRole: { include: { productAccess: true } } },
            },
          },
        });
      });
    }

    const token = await this.createOneTimeToken({
      organizationId,
      userId: user.id,
      email,
      type: 'invite',
      expiresAt: this.getInviteExpiresAt(),
      metadata: {
        roles,
        clearanceLevel: input.clearanceLevel ?? 0,
        productAccess: input.productAccess ?? [],
        customRoleIds: input.customRoleIds ?? [],
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'auth.invite_created',
      entityType: 'user',
      entityId: user.id,
      metadata: {
        email,
        roles,
        productAccess: input.productAccess ?? [],
        customRoleIds: input.customRoleIds ?? [],
      },
    });

    return {
      invited: true,
      email,
      userId: user.id,
      expiresAt: token.expiresAt,
      ...(this.shouldExposeDevToken() ? { devInviteToken: token.token } : {}),
    };
  }

  async acceptInvite(
    input: AcceptInviteDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponse> {
    const record = await this.consumeOneTimeToken({
      token: input.token,
      type: 'invite',
    });

    if (!record.userId) {
      throw new BadRequestException('Invalid invite token');
    }

    const user = await this.prisma.user.update({
      where: { id: record.userId },
      data: {
        name: input.name,
        passwordHash: await hashPassword(input.password, 12),
        isActive: true,
      },
      include: {
        productAccess: true,
        customRoleAssignments: {
          where: { customRole: { isActive: true } },
          include: { customRole: { include: { productAccess: true } } },
        },
      },
    });
    const safeUser = this.usersService.toSafeUser(user);

    await this.auditService.record({
      actor: this.toAuthenticatedUser(safeUser),
      organizationId: record.organizationId,
      action: 'auth.invite_accepted',
      entityType: 'user',
      entityId: user.id,
    });

    return this.issueAuthResponse(safeUser, {
      ...context,
      userAgent: input.userAgent ?? context.userAgent,
    });
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

  private async issueAuthResponse(
    user: SafeUser,
    context: AuthRequestContext = {},
  ): Promise<AuthResponse> {
    const refreshToken = await this.createRefreshSession(user, context);

    return {
      accessToken: await this.issueAccessToken(user),
      refreshToken,
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
      clearanceLevel: user.clearanceLevel,
      productAccess: user.productAccess,
      customRoles: user.customRoles,
    };
  }

  private getAccessTokenExpiresIn(): string {
    return this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      APPLICATION_DEFAULTS.auth.accessTokenExpiresIn,
    );
  }

  private async issueAccessToken(user: SafeUser): Promise<string> {
    return this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        orgId: user.orgId,
        customRoleIds: user.customRoles.map((role) => role.id),
      },
      {
        expiresIn: this.getAccessTokenExpiresIn() as '15m',
      },
    );
  }

  private async createRefreshSession(
    user: SafeUser,
    context: AuthRequestContext,
  ): Promise<string> {
    const refreshToken = this.generateToken();

    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        organizationId: user.orgId,
        tokenHash: this.hashToken(refreshToken),
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
        expiresAt: this.getRefreshTokenExpiresAt(),
      },
    });

    return refreshToken;
  }

  private async createOneTimeToken(input: {
    organizationId: string;
    userId?: string;
    email: string;
    type: 'invite' | 'password_reset';
    expiresAt: Date;
    metadata?: Record<string, unknown>;
  }) {
    await this.prisma.authOneTimeToken.updateMany({
      where: {
        type: input.type,
        email: this.normalizeEmail(input.email),
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const token = this.generateToken();
    const record = await this.prisma.authOneTimeToken.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        type: input.type,
        email: this.normalizeEmail(input.email),
        tokenHash: this.hashToken(token),
        expiresAt: input.expiresAt,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });

    return { token, expiresAt: record.expiresAt };
  }

  private async consumeOneTimeToken(input: {
    token: string;
    type: 'invite' | 'password_reset';
  }) {
    const record = await this.prisma.authOneTimeToken.findUnique({
      where: { tokenHash: this.hashToken(input.token) },
    });

    if (
      !record ||
      record.type !== input.type ||
      record.consumedAt ||
      record.expiresAt <= new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }

    return this.prisma.authOneTimeToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ): string {
    if (!organizationId) {
      return currentUser.orgId;
    }

    if (
      !currentUser.roles.includes('super_admin') &&
      organizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException(
        'Cannot invite users to another organization',
      );
    }

    return organizationId;
  }

  private assertAllowedRoles(
    currentUser: AuthenticatedUser,
    roles: UserRole[],
  ) {
    if (!roles.length) {
      throw new BadRequestException('At least one role is required');
    }

    if (
      !currentUser.roles.includes('super_admin') &&
      roles.includes('super_admin')
    ) {
      throw new ForbiddenException(
        'Organization admins cannot assign super_admin',
      );
    }
  }

  private getRefreshTokenExpiresAt(): Date {
    return this.addDays(
      this.configService.get<number>('REFRESH_TOKEN_EXPIRES_DAYS') ??
        APPLICATION_DEFAULTS.auth.refreshTokenExpiresDays,
    );
  }

  private getInviteExpiresAt(): Date {
    return this.addHours(
      this.configService.get<number>('AUTH_INVITE_TOKEN_EXPIRES_HOURS') ??
        APPLICATION_DEFAULTS.auth.inviteTokenExpiresHours,
    );
  }

  private getPasswordResetExpiresAt(): Date {
    return this.addMinutes(
      this.configService.get<number>(
        'AUTH_PASSWORD_RESET_TOKEN_EXPIRES_MINUTES',
      ) ?? APPLICATION_DEFAULTS.auth.passwordResetTokenExpiresMinutes,
    );
  }

  private addDays(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60_000);
  }

  private addHours(hours: number): Date {
    return new Date(Date.now() + hours * 60 * 60_000);
  }

  private addMinutes(minutes: number): Date {
    return new Date(Date.now() + minutes * 60_000);
  }

  private generateToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private shouldExposeDevToken(): boolean {
    return this.configService.get<string>('NODE_ENV') !== 'production';
  }
}
