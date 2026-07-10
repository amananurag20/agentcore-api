import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { AuthService } from './auth.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { Roles } from '../common/auth/roles.decorator';
import type { Request } from 'express';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiCreatedResponse({
    type: AuthResponseDto,
    description: 'Returns a JWT access token and the authenticated user.',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body() body: LoginDto, @Req() request: Request) {
    return this.authService.login(body, this.toAuthContext(request));
  }

  @Post('register')
  @Roles('super_admin')
  @ApiOperation({
    summary: 'Create an organization admin in an existing organization',
  })
  @ApiCreatedResponse({
    type: AuthResponseDto,
    description: 'Creates an org admin user and returns a JWT access token.',
  })
  register(@Body() body: RegisterDto, @Req() request: Request) {
    return this.authService.register(body, this.toAuthContext(request));
  }

  @Public()
  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate refresh token and issue a new access token',
  })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired refresh token.' })
  refresh(@Body() body: RefreshTokenDto, @Req() request: Request) {
    return this.authService.refresh(body, this.toAuthContext(request));
  }

  @Post('logout')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Logout and revoke the supplied refresh token' })
  @ApiOkResponse({ schema: { example: { loggedOut: true } } })
  logout(@CurrentUser() user: AuthenticatedUser, @Body() body: LogoutDto) {
    return this.authService.logout(user, body.refreshToken);
  }

  @Post('logout-all')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Logout from all devices by revoking sessions' })
  @ApiOkResponse({ schema: { example: { loggedOut: true } } })
  logoutAll(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.logoutAll(user);
  }

  @Public()
  @Post('password-reset/request')
  @ApiOperation({ summary: 'Request a password reset token' })
  @ApiCreatedResponse({
    schema: {
      example: {
        requested: true,
        devResetToken: 'returned outside production only',
      },
    },
  })
  requestPasswordReset(@Body() body: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(body);
  }

  @Public()
  @Post('password-reset/confirm')
  @ApiOperation({ summary: 'Confirm a password reset token' })
  @ApiCreatedResponse({ schema: { example: { reset: true } } })
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body);
  }

  @Post('invites')
  @ApiBearerAuth('bearer')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Invite a user to an organization' })
  @ApiCreatedResponse({
    schema: {
      example: {
        invited: true,
        email: 'agent@agentcore.local',
        userId: 'uuid',
        devInviteToken: 'returned outside production only',
      },
    },
  })
  createInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateInviteDto,
  ) {
    return this.authService.createInvite(user, body);
  }

  @Public()
  @Post('invites/accept')
  @ApiOperation({
    summary: 'Accept an organization invite and create password',
  })
  @ApiCreatedResponse({ type: AuthResponseDto })
  acceptInvite(@Body() body: AcceptInviteDto, @Req() request: Request) {
    return this.authService.acceptInvite(body, this.toAuthContext(request));
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get the current authenticated user' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, or expired JWT.' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user);
  }

  private toAuthContext(request: Request) {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    };
  }
}
