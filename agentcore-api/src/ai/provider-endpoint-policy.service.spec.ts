import { BadRequestException } from '@nestjs/common';
import { ProviderEndpointPolicyService } from './provider-endpoint-policy.service';

function service(values: Record<string, unknown> = {}) {
  return new ProviderEndpointPolicyService({
    get: jest.fn((key: string) => values[key]),
  } as never);
}

describe('ProviderEndpointPolicyService', () => {
  it('allows official provider endpoints', async () => {
    await expect(
      service().assertUrlAllowed('https://api.openai.com/v1'),
    ).resolves.toBeUndefined();
  });

  it.each([
    'http://127.0.0.1:8080/v1',
    'http://localhost:11434',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/v1',
  ])('blocks private endpoint %s by default', async (endpoint) => {
    await expect(service().assertUrlAllowed(endpoint)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects URLs containing credentials', async () => {
    await expect(
      service().assertUrlAllowed('https://user:secret@example.com/v1'),
    ).rejects.toThrow('must not contain credentials');
  });

  it('allows an explicitly allowlisted private provider', async () => {
    await expect(
      service({
        AI_PROVIDER_ALLOWED_HOSTS: '127.0.0.1:11434',
      }).assertUrlAllowed('http://127.0.0.1:11434/v1'),
    ).resolves.toBeUndefined();
  });

  it('requires an explicit allowlist entry for custom production endpoints', async () => {
    await expect(
      service({ NODE_ENV: 'production' }).assertUrlAllowed(
        'https://example.com/v1',
      ),
    ).rejects.toThrow('not allowlisted');
  });
});
