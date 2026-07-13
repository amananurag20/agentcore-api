import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import {
  CreateServicePrincipalDto,
  IssueServiceTokenDto,
} from './dto/service-principal.dto';

@Injectable()
export class ServicePrincipalsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly policyService: PolicyService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async list(actor: AuthenticatedUser, requestedOrgId?: string) {
    const organizationId = this.resolveOrganizationId(actor, requestedOrgId);
    return this.prisma.servicePrincipal.findMany({
      where: { organizationId },
      select: this.safeSelect(),
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(actor: AuthenticatedUser, input: CreateServicePrincipalDto) {
    const organizationId = this.resolveOrganizationId(actor, input.orgId);
    await this.assertCanManage(actor, input.productKey);
    const clientSecret = this.generateSecret();
    const principal = await this.prisma.servicePrincipal.create({
      data: {
        organizationId,
        productKey: input.productKey,
        name: input.name.trim(),
        clientId: `sp_${randomBytes(18).toString('base64url')}`,
        secretHash: this.hashSecret(clientSecret),
        createdById: actor.sub,
      },
      select: this.safeSelect(),
    });
    await this.auditService.record({
      actor,
      organizationId,
      action: 'service_principal.created',
      entityType: 'service_principal',
      entityId: principal.id,
      metadata: { name: principal.name, productKey: principal.productKey },
    });
    return { ...principal, clientSecret };
  }

  async rotate(actor: AuthenticatedUser, id: string) {
    const existing = await this.findForActor(actor, id);
    await this.assertCanManage(actor, existing.productKey);
    const clientSecret = this.generateSecret();
    const principal = await this.prisma.servicePrincipal.update({
      where: { id },
      data: { secretHash: this.hashSecret(clientSecret) },
      select: this.safeSelect(),
    });
    await this.auditService.record({
      actor,
      organizationId: principal.organizationId,
      action: 'service_principal.secret_rotated',
      entityType: 'service_principal',
      entityId: id,
    });
    return { ...principal, clientSecret };
  }

  async setStatus(actor: AuthenticatedUser, id: string, isActive: boolean) {
    const existing = await this.findForActor(actor, id);
    await this.assertCanManage(actor, existing.productKey);
    const principal = await this.prisma.servicePrincipal.update({
      where: { id },
      data: { isActive },
      select: this.safeSelect(),
    });
    await this.auditService.record({
      actor,
      organizationId: principal.organizationId,
      action: 'service_principal.status_updated',
      entityType: 'service_principal',
      entityId: id,
      metadata: { isActive },
    });
    return principal;
  }

  async issueToken(input: IssueServiceTokenDto) {
    const principal = await this.prisma.servicePrincipal.findUnique({
      where: { clientId: input.clientId },
    });
    if (
      !principal?.isActive ||
      !this.secretsEqual(principal.secretHash, input.clientSecret)
    ) {
      throw new UnauthorizedException('Invalid service credentials');
    }

    let clearanceLevel = 0;
    let forwardedUserId: string | undefined;
    if (input.forwardedAccessToken) {
      let payload: { sub?: string };
      try {
        payload = await this.jwtService.verifyAsync(input.forwardedAccessToken);
      } catch {
        throw new UnauthorizedException('Invalid forwarded user token');
      }
      if (!payload.sub)
        throw new UnauthorizedException('Invalid forwarded user token');
      const user = await this.usersService.findById(payload.sub);
      if (!user?.isActive || user.orgId !== principal.organizationId) {
        throw new UnauthorizedException('Forwarded user is unavailable');
      }
      const context = this.toAuthenticatedUser(user);
      await this.policyService.assertProductAccess(
        context,
        principal.productKey,
        'use',
      );
      clearanceLevel = this.policyService.getEffectiveClearance(
        context,
        principal.productKey,
      );
      forwardedUserId = user.id;
    }

    await this.prisma.servicePrincipal.update({
      where: { id: principal.id },
      data: { lastUsedAt: new Date() },
    });
    const expiresIn = this.configService.get<string>(
      'SERVICE_TOKEN_EXPIRES_IN',
      '5m',
    );
    const accessToken = await this.jwtService.signAsync(
      {
        sub: forwardedUserId ?? principal.id,
        orgId: principal.organizationId,
        principalType: 'service',
        servicePrincipalId: principal.id,
        serviceProductKey: principal.productKey,
        forwardedUserId,
        clearanceLevel,
      },
      { expiresIn: expiresIn as '5m' },
    );
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }

  private async findForActor(actor: AuthenticatedUser, id: string) {
    const principal = await this.prisma.servicePrincipal.findUnique({
      where: { id },
    });
    if (
      !principal ||
      (!actor.roles.includes('super_admin') &&
        principal.organizationId !== actor.orgId)
    ) {
      throw new NotFoundException('Service principal not found');
    }
    return principal;
  }

  private async assertCanManage(
    actor: AuthenticatedUser,
    productKey: CreateServicePrincipalDto['productKey'],
  ) {
    if (
      actor.roles.includes('super_admin') ||
      actor.roles.includes('org_admin')
    )
      return;
    await this.policyService.assertProductAccess(
      actor,
      productKey,
      'configure',
    );
  }

  private resolveOrganizationId(actor: AuthenticatedUser, requested?: string) {
    if (requested && actor.roles.includes('super_admin')) return requested;
    if (requested && requested !== actor.orgId) {
      throw new ForbiddenException('Cannot manage another organization');
    }
    return requested ?? actor.orgId;
  }

  private safeSelect() {
    return {
      id: true,
      organizationId: true,
      productKey: true,
      name: true,
      clientId: true,
      isActive: true,
      createdById: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    } as const;
  }

  private generateSecret() {
    return randomBytes(48).toString('base64url');
  }

  private hashSecret(secret: string) {
    return createHash('sha256').update(secret).digest('hex');
  }

  private secretsEqual(expectedHash: string, suppliedSecret: string) {
    const actual = Buffer.from(this.hashSecret(suppliedSecret), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private toAuthenticatedUser(
    user: Awaited<ReturnType<UsersService['findById']>> & {},
  ) {
    return {
      sub: user.id,
      email: user.email,
      orgId: user.orgId,
      roles: user.roles,
      clearanceLevel: user.clearanceLevel,
      productAccess: user.productAccess,
      customRoles: user.customRoles,
      principalType: 'user' as const,
    };
  }
}
