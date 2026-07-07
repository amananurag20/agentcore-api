import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth/public.decorator';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Check API and database health' })
  @ApiOkResponse({
    description: 'API and database are reachable.',
    schema: {
      example: {
        status: 'ok',
        database: 'ok',
        redis: { status: 'ok' },
        queue: { status: 'enabled', prefix: 'agentcore' },
        storage: {
          status: 'disabled',
          provider: 's3',
          bucketConfigured: false,
        },
        uptime: 12.34,
        timestamp: '2026-07-06T06:00:00.000Z',
      },
    },
  })
  getHealth() {
    return this.healthService.getHealth();
  }
}
