import { ConfigService } from '@nestjs/config';
import { VoiceRetentionService } from './voice-retention.service';

describe('VoiceRetentionService', () => {
  it('purges expired encrypted recording and transcript fields', async () => {
    const updateCall = jest.fn<
      (input: unknown) => Promise<Record<string, never>>
    >(() => Promise.resolve({}));
    const updateEvents = jest.fn<
      (input: unknown) => Promise<{ count: number }>
    >(() => Promise.resolve({ count: 1 }));
    const prisma = {
      voiceCall: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'call-1',
            recordingSid: null,
            config: { provider: 'custom' },
          },
        ]),
        update: updateCall,
      },
      voiceCallEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: updateEvents,
      },
      $transaction: jest.fn(async (queries: Array<Promise<unknown>>) =>
        Promise.all(queries),
      ),
    };
    const service = new VoiceRetentionService(
      {
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      { encrypt: jest.fn((value: string) => `encrypted:${value}`) } as never,
      { deleteRecording: jest.fn() } as never,
      prisma as never,
    );

    await expect(service.sweep()).resolves.toBe(1);
    const callUpdate = updateCall.mock.calls[0]?.[0] as {
      data: { recordingUrlEncrypted: null; recordingSid: null };
    };
    expect(callUpdate.data.recordingUrlEncrypted).toBeNull();
    expect(callUpdate.data.recordingSid).toBeNull();
    const eventUpdate = updateEvents.mock.calls[0]?.[0] as {
      data: { contentEncrypted: null; audioUrlEncrypted: null };
    };
    expect(eventUpdate.data.contentEncrypted).toBeNull();
    expect(eventUpdate.data.audioUrlEncrypted).toBeNull();
  });

  it('encrypts legacy plaintext dialogue events in place', async () => {
    const updateEvent = jest.fn<
      (input: unknown) => Promise<Record<string, never>>
    >(() => Promise.resolve({}));
    const prisma = {
      voiceCall: { findMany: jest.fn().mockResolvedValue([]) },
      voiceCallEvent: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'event-1', content: 'Sensitive caller transcript' },
          ])
          .mockResolvedValue([]),
        update: updateEvent,
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (queries: Array<Promise<unknown>>) =>
        Promise.all(queries),
      ),
    };
    const service = new VoiceRetentionService(
      {
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      { encrypt: jest.fn((value: string) => `encrypted:${value}`) } as never,
      { deleteRecording: jest.fn() } as never,
      prisma as never,
    );

    await expect(service.sweep()).resolves.toBe(0);
    const update = updateEvent.mock.calls[0]?.[0] as {
      data: { content: null; contentEncrypted: string };
    };
    expect(update.data).toEqual({
      content: null,
      contentEncrypted: 'encrypted:Sensitive caller transcript',
    });
  });
});
