import { BadRequestException } from '@nestjs/common';
import { AppointmentTimezoneService } from './appointment-timezone.service';

describe('AppointmentTimezoneService', () => {
  const service = new AppointmentTimezoneService();

  it('converts local wall-clock times to UTC', () => {
    expect(
      service.localToUtc('2026-08-01', '09:00', 'Asia/Kolkata').toISOString(),
    ).toBe('2026-08-01T03:30:00.000Z');
  });

  it('applies daylight-saving offsets for the requested date', () => {
    expect(
      service
        .localToUtc('2026-01-15', '09:00', 'America/New_York')
        .toISOString(),
    ).toBe('2026-01-15T14:00:00.000Z');
    expect(
      service
        .localToUtc('2026-07-15', '09:00', 'America/New_York')
        .toISOString(),
    ).toBe('2026-07-15T13:00:00.000Z');
  });

  it('rejects nonexistent local times during the DST spring-forward gap', () => {
    expect(() =>
      service.localToUtc('2026-03-08', '02:30', 'America/New_York'),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid IANA timezone identifiers', () => {
    expect(() => service.assertValid('Mars/Olympus_Mons')).toThrow(
      BadRequestException,
    );
  });

  it('adds local months without overflowing shorter months', () => {
    expect(service.addLocalMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(service.addLocalMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('extracts local wall-clock time for recurrence materialization', () => {
    expect(
      service.timeInZone(
        new Date('2026-07-15T13:45:30.000Z'),
        'America/New_York',
      ),
    ).toBe('09:45:30');
  });
});
