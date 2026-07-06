import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: AuthenticatedUser): AuthenticatedUser {
    const user = this.usersService.findById(payload.sub);

    if (!user?.isActive) {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }

    return {
      sub: user.id,
      email: user.email,
      orgId: user.orgId,
      roles: user.roles,
    };
  }
}
