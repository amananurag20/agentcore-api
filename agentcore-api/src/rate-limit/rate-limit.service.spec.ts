import { HttpStatus } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  it('blocks requests after the configured in-memory limit', async () => {
    const service = new RateLimitService({
      get: (key: string) => (key === 'QUEUE_PREFIX' ? 'test' : undefined),
    } as never);

    await service.consume('public-chat:test', 2, 60);
    await service.consume('public-chat:test', 2, 60);

    await expect(
      service.consume('public-chat:test', 2, 60),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    await service.onModuleDestroy();
  });
});
