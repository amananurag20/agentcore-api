import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { Roles } from '../common/auth/roles.decorator';
import { UserResponseDto } from '../auth/dto/user-response.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('bearer')
@Controller('users')
@Roles('super_admin', 'org_admin')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List users visible to the current admin' })
  @ApiOkResponse({ type: UserResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.listManagedUsers(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a user in an organization' })
  @ApiCreatedResponse({ type: UserResponseDto })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateUserDto) {
    return this.usersService.createManagedUser(user, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ type: UserResponseDto })
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.getManagedUser(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile fields' })
  @ApiOkResponse({ type: UserResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.usersService.updateManagedUser(user, id, body);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a user' })
  @ApiOkResponse({ type: UserResponseDto })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.usersService.updateManagedUserStatus(user, id, body.status);
  }

  @Patch(':id/roles')
  @ApiOperation({ summary: 'Update user roles' })
  @ApiOkResponse({ type: UserResponseDto })
  updateRoles(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserRolesDto,
  ) {
    return this.usersService.updateManagedUserRoles(user, id, body.roles);
  }
}
