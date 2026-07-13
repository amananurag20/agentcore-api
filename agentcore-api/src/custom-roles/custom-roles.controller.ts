import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { Roles } from '../common/auth/roles.decorator';
import { CustomRolesService } from './custom-roles.service';
import {
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
} from './dto/upsert-custom-role.dto';

@ApiTags('Custom Roles')
@ApiBearerAuth('bearer')
@Controller('custom-roles')
@Roles('super_admin', 'org_admin', 'product_admin')
export class CustomRolesController {
  constructor(private readonly customRolesService: CustomRolesService) {}

  @Get()
  @ApiOperation({ summary: 'List tenant-defined roles' })
  list(@CurrentUser() user: AuthenticatedUser, @Query('orgId') orgId?: string) {
    return this.customRolesService.list(user, orgId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customRolesService.get(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCustomRoleDto,
  ) {
    return this.customRolesService.create(user, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateCustomRoleDto,
  ) {
    return this.customRolesService.update(user, id, body);
  }

  @Delete(':id')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customRolesService.archive(user, id);
  }
}
