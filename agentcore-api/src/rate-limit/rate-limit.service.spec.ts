import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService leases', () => {
  function createService() {
    const values: Record<string, unknown> = {
      NODE_ENV: 'test',
      RATE_LIMIT_FAIL_CLOSED: false,
    };
    return new RateLimitService({
      get: (key: string) => values[key],
    } as ConfigService);
  }

  it('allows only the owning token to release a generation lease', async () => {
    const service = createService();
    await expect(
      service.acquireLease('conversation-a', 'owner-a', 30),
    ).resolves.toBe(true);
    await expect(
      service.acquireLease('conversation-a', 'owner-b', 30),
    ).resolves.toBe(false);

    await service.releaseLease('conversation-a', 'owner-b');
    await expect(
      service.acquireLease('conversation-a', 'owner-b', 30),
    ).resolves.toBe(false);

    await service.releaseLease('conversation-a', 'owner-a');
    await expect(
      service.acquireLease('conversation-a', 'owner-b', 30),
    ).resolves.toBe(true);
    await service.onModuleDestroy();
  });
});
