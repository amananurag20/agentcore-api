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
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { RequireProductAccess } from '../common/auth/product-access.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import {
  AssignLeadDto,
  CreateLeadWebhookDto,
  ListLeadAlertsDto,
  ListLeadWebhookDeliveriesDto,
  UpdateLeadConsentDto,
  UpdateLeadWebhookDto,
} from './dto/lead-operations.dto';
import { LeadOperationsService } from './lead-operations.service';
import { LeadsService } from './leads.service';

@ApiTags('Leads')
@ApiBearerAuth('bearer')
@Controller('leads')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent')
@RequireProductAccess('customer_chat')
export class LeadsController {
  constructor(
    private readonly leadOperationsService: LeadOperationsService,
    private readonly leadsService: LeadsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List captured customer-chat leads' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListLeadsDto) {
    return this.leadsService.list(user, query);
  }

  @Get('operations/assignable-users')
  assignableUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.leadOperationsService.listAssignableUsers(user, organizationId);
  }

  @Get('operations/alerts')
  alerts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadAlertsDto,
  ) {
    return this.leadOperationsService.listAlerts(user, query);
  }

  @Patch('operations/alerts/:id/read')
  markAlertRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.leadOperationsService.markAlertRead(user, id);
  }

  @Get('operations/webhooks')
  webhooks(@CurrentUser() user: AuthenticatedUser) {
    return this.leadOperationsService.listWebhooks(user);
  }

  @Post('operations/webhooks')
  createWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateLeadWebhookDto,
  ) {
    return this.leadOperationsService.createWebhook(user, body);
  }

  @Patch('operations/webhooks/:id')
  updateWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateLeadWebhookDto,
  ) {
    return this.leadOperationsService.updateWebhook(user, id, body);
  }

  @Delete('operations/webhooks/:id')
  deleteWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.leadOperationsService.deleteWebhook(user, id);
  }

  @Get('operations/webhook-deliveries')
  webhookDeliveries(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadWebhookDeliveriesDto,
  ) {
    return this.leadOperationsService.listDeliveries(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a captured lead and recent conversations' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.get(user, id);
  }

  @Get(':id/score-history')
  @ApiOperation({ summary: 'Get audited manual lead score changes' })
  scoreHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.leadsService.getScoreHistory(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update lead status, contact details, tags or notes',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateLeadDto,
  ) {
    return this.leadsService.update(user, id, body);
  }

  @Patch(':id/assignment')
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AssignLeadDto,
  ) {
    return this.leadsService.assign(user, id, body.ownerId);
  }

  @Patch(':id/consent')
  updateConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateLeadConsentDto,
  ) {
    return this.leadsService.updateConsent(user, id, body.status, body.source);
  }

  @Delete(':id')
  deleteLead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.deleteLead(user, id);
  }
}
