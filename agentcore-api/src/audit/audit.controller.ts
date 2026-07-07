import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { AuditService } from './audit.service';
import { AuditLogListDto } from './dto/audit-log-response.dto';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@ApiTags('Audit Logs')
@ApiBearerAuth('bearer')
@Controller('audit-logs')
@Roles('super_admin', 'org_admin')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit logs' })
  @ApiOkResponse({ type: AuditLogListDto })
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.auditService.list(currentUser, query);
  }
}
