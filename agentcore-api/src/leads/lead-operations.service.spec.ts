import { BadRequestException } from '@nestjs/common';
import { LeadOperationsService } from './lead-operations.service';

describe('LeadOperationsService', () => {
  const service = new LeadOperationsService(
    { record: jest.fn() } as never,
    { get: jest.fn((_key: string, fallback: unknown) => fallback) } as never,
    { encrypt: jest.fn(), decrypt: jest.fn() } as never,
    {} as never,
  );

  it('uses safe operational defaults', () => {
    expect(service.readPolicy(undefined)).toEqual({
      autoAssign: 'none',
      firstResponseMinutes: 30,
      alertPriority: 'hot',
      retentionDays: 0,
    });
  });

  it('reads per-widget routing, SLA, alert and retention policy', () => {
    expect(
      service.readPolicy({
        leadOperations: {
          autoAssign: 'round_robin',
          firstResponseMinutes: 15,
          alertPriority: 'high',
          retentionDays: 365,
        },
      }),
    ).toEqual({
      autoAssign: 'round_robin',
      firstResponseMinutes: 15,
      alertPriority: 'high',
      retentionDays: 365,
    });
  });

  it('rejects unsafe policy values in strict mode', () => {
    expect(() =>
      service.readPolicy(
        { leadOperations: { firstResponseMinutes: 0 } },
        true,
      ),
    ).toThrow(BadRequestException);
  });
});
