import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/auth/roles.decorator';
import { ObservabilityService } from './observability.service';

@ApiTags('Observability')
@ApiBearerAuth('bearer')
@Controller('observability')
@Roles('super_admin', 'org_admin')
export class ObservabilityController {
  constructor(private readonly observabilityService: ObservabilityService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get operational summary across product modules' })
  @ApiOkResponse({
    schema: {
      example: {
        generatedAt: '2026-07-08T08:00:00.000Z',
        process: {
          uptimeSeconds: 120,
          memoryRssMb: 180,
          memoryHeapUsedMb: 90,
        },
        audit: { events24h: 42 },
        customerChat: { open: 3, waitingForAgent: 1 },
        whatsappAssistant: { open: 2, waitingForAgent: 1 },
        voiceReceptionist: { inProgress: 1, waitingForAgent: 0 },
        appointmentBooking: { upcoming: 8, cancelled24h: 1 },
        knowledge: { readySources: 4, failedSources: 0 },
      },
    },
  })
  getSummary() {
    return this.observabilityService.getSummary();
  }
}
