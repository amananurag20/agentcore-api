import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AuthenticatedUser): Promise<AuthenticatedUser> {
    if (payload.principalType === 'service' && payload.servicePrincipalId) {
      const principal = await this.prisma.servicePrincipal.findUnique({
        where: { id: payload.servicePrincipalId },
      });
      if (
        !principal?.isActive ||
        principal.organizationId !== payload.orgId ||
        principal.productKey !== payload.serviceProductKey
      ) {
        throw new UnauthorizedException(
          'Service principal is inactive or unavailable',
        );
      }
      return {
        sub: payload.sub,
        email: `${principal.clientId}@service.agentcore.local`,
        orgId: principal.organizationId,
        roles: ['user'],
        clearanceLevel: payload.clearanceLevel ?? 0,
        productAccess: [
          {
            productKey: principal.productKey,
            canUse: true,
            canConfigure: false,
            canManageAgents: false,
            canManageKnowledge: false,
          },
        ],
        customRoles: [],
        principalType: 'service',
        servicePrincipalId: principal.id,
        serviceProductKey: principal.productKey,
        forwardedUserId: payload.forwardedUserId,
      };
    }

    const user = await this.usersService.findById(payload.sub);

    if (!user?.isActive) {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }

    return {
      sub: user.id,
      email: user.email,
      orgId: user.orgId,
      roles: user.roles,
      clearanceLevel: user.clearanceLevel,
      productAccess: user.productAccess,
      customRoles: user.customRoles,
      principalType: 'user',
    };
  }
}
