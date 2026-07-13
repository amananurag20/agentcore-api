import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { Public } from '../common/auth/public.decorator';
import { Roles } from '../common/auth/roles.decorator';
import {
  CreateServicePrincipalDto,
  IssueServiceTokenDto,
  UpdateServicePrincipalStatusDto,
} from './dto/service-principal.dto';
import { ServicePrincipalsService } from './service-principals.service';

@ApiTags('Service Principals')
@ApiBearerAuth('bearer')
@Controller('service-principals')
@Roles('super_admin', 'org_admin', 'product_admin')
export class ServicePrincipalsController {
  constructor(private readonly service: ServicePrincipalsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('orgId') orgId?: string) {
    return this.service.list(user, orgId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateServicePrincipalDto,
  ) {
    return this.service.create(user, body);
  }

  @Post(':id/rotate')
  rotate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.rotate(user, id);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateServicePrincipalStatusDto,
  ) {
    return this.service.setStatus(user, id, body.isActive);
  }
}

@ApiTags('Internal Authentication')
@Controller('internal/auth')
export class InternalAuthController {
  constructor(private readonly service: ServicePrincipalsService) {}

  @Public()
  @Post('service-token')
  issueServiceToken(@Body() body: IssueServiceTokenDto) {
    return this.service.issueToken(body);
  }
}
