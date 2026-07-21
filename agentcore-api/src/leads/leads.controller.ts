import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { RequireProductAccess } from '../common/auth/product-access.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadsService } from './leads.service';

@ApiTags('Leads')
@ApiBearerAuth('bearer')
@Controller('leads')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent')
@RequireProductAccess('customer_chat')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @ApiOperation({ summary: 'List captured customer-chat leads' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListLeadsDto) {
    return this.leadsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a captured lead and recent conversations' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.get(user, id);
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
}
