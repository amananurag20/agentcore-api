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
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationResponseDto } from './dto/organization-response.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('Organizations')
@ApiBearerAuth('bearer')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @Roles('super_admin')
  @ApiOperation({ summary: 'Create an organization' })
  @ApiCreatedResponse({ type: OrganizationResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(body, user);
  }

  @Get('me')
  @ApiOperation({ summary: "Get the current user's organization" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  getCurrentOrganization(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.findById(user.orgId);
  }

  @Patch('me')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: "Update the current user's organization" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  updateCurrentOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(user.orgId, body, user);
  }

  @Get(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Get an organization by id' })
  @ApiOkResponse({ type: OrganizationResponseDto })
  getById(@Param('id') id: string) {
    return this.organizationsService.findById(id);
  }
}
