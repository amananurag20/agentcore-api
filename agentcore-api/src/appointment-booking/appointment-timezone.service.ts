import { BadRequestException, Injectable } from '@nestjs/common';

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

@Injectable()
export class AppointmentTimezoneService {
  assertValid(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      throw new BadRequestException(`Invalid IANA timezone: ${timezone}`);
    }
  }

  startOfDay(date: string, timezone: string): Date {
    return this.localToUtc(date, '00:00', timezone);
  }

  nextDayStart(date: string, timezone: string): Date {
    return this.localToUtc(this.addLocalDays(date, 1), '00:00', timezone);
  }

  localToUtc(date: string, time: string, timezone: string): Date {
    this.assertValid(timezone);
    const requested = this.parseLocal(date, time);
    const requestedUtcMs = Date.UTC(
      requested.year,
      requested.month - 1,
      requested.day,
      requested.hour,
      requested.minute,
      requested.second,
    );

    let candidateMs = requestedUtcMs;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const displayed = this.partsInZone(new Date(candidateMs), timezone);
      const displayedUtcMs = Date.UTC(
        displayed.year,
        displayed.month - 1,
        displayed.day,
        displayed.hour,
        displayed.minute,
        displayed.second,
      );
      const adjustment = requestedUtcMs - displayedUtcMs;
      candidateMs += adjustment;
      if (adjustment === 0) break;
    }

    const candidate = new Date(candidateMs);
    const actual = this.partsInZone(candidate, timezone);
    if (!this.sameLocalDateTime(requested, actual)) {
      throw new BadRequestException(
        `Local time ${date} ${time} does not exist in ${timezone} because of a daylight-saving transition`,
      );
    }

    return candidate;
  }

  dateInZone(instant: Date, timezone: string): string {
    const parts = this.partsInZone(instant, timezone);
    return `${parts.year}-${this.pad(parts.month)}-${this.pad(parts.day)}`;
  }

  dayOfWeek(date: string): number {
    return new Date(`${date}T00:00:00.000Z`).getUTCDay();
  }

  addLocalDays(date: string, days: number): string {
    const parsed = this.parseLocal(date, '00:00');
    const result = new Date(
      Date.UTC(parsed.year, parsed.month - 1, parsed.day + days),
    );
    return result.toISOString().slice(0, 10);
  }

  addLocalMonths(date: string, months: number): string {
    const parsed = this.parseLocal(date, '00:00');
    const targetMonth = new Date(
      Date.UTC(parsed.year, parsed.month - 1 + months, 1),
    );
    const lastDay = new Date(
      Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const result = new Date(
      Date.UTC(
        targetMonth.getUTCFullYear(),
        targetMonth.getUTCMonth(),
        Math.min(parsed.day, lastDay),
      ),
    );
    return result.toISOString().slice(0, 10);
  }

  timeInZone(instant: Date, timezone: string): string {
    const parts = this.partsInZone(instant, timezone);
    return `${this.pad(parts.hour)}:${this.pad(parts.minute)}:${this.pad(parts.second)}`;
  }

  shiftWallClock(
    occurrence: Date,
    reference: Date,
    requested: Date,
    timezone: string,
  ): Date {
    const referenceDate = this.dateInZone(reference, timezone);
    const requestedDate = this.dateInZone(requested, timezone);
    const dayShift = Math.round(
      (Date.parse(`${requestedDate}T00:00:00.000Z`) -
        Date.parse(`${referenceDate}T00:00:00.000Z`)) /
        (24 * 60 * 60_000),
    );
    return this.localToUtc(
      this.addLocalDays(this.dateInZone(occurrence, timezone), dayShift),
      this.timeInZone(requested, timezone),
      timezone,
    );
  }

  private partsInZone(instant: Date, timezone: string): LocalDateTime {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(instant)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );

    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
  }

  private parseLocal(date: string, time: string): LocalDateTime {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute, second = 0] = time.split(':').map(Number);
    return { year, month, day, hour, minute, second };
  }

  private sameLocalDateTime(left: LocalDateTime, right: LocalDateTime) {
    return (
      left.year === right.year &&
      left.month === right.month &&
      left.day === right.day &&
      left.hour === right.hour &&
      left.minute === right.minute &&
      left.second === right.second
    );
  }

  private pad(value: number): string {
    return String(value).padStart(2, '0');
  }
}
