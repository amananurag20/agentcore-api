import { ConfigService } from '@nestjs/config';
import { VoiceReceptionistConfig } from '@prisma/client';
import { VoiceRuntimeService } from './voice-runtime.service';

describe('VoiceRuntimeService session ownership', () => {
  const config = {
    id: 'config-1',
    organizationId: 'org-1',
  } as VoiceReceptionistConfig;

  it('does not let an old socket unregister its replacement', async () => {
    const service = new VoiceRuntimeService({
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService);
    const closeOld = jest.fn();
    const sendOld = jest.fn();
    const sendNew = jest.fn();
    service.registerSession(config, 'CA123', 'old', sendOld, closeOld);
    service.registerSession(config, 'CA123', 'new', sendNew, jest.fn());

    service.unregisterSession('CA123', 'old');
    await expect(service.sendText('CA123', 'Agent here')).resolves.toBe(true);
    expect(closeOld).toHaveBeenCalled();
    expect(sendOld).not.toHaveBeenCalled();
    expect(sendNew).toHaveBeenCalledWith('Agent here', undefined);
    await service.onModuleDestroy();
  });
});
