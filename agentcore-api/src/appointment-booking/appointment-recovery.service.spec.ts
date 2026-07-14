import { AppointmentCalendarRecoveryService } from './appointment-calendar-recovery.service';
import { AppointmentReminderRecoveryService } from './appointment-reminder-recovery.service';

describe('Appointment recovery dead letters', () => {
  const now = new Date();
  const audit = { record: jest.fn() };
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  };
  const queue = {
    isEnabled: jest.fn(() => true),
    remove: jest.fn(),
    add: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('dead-letters a terminal reminder and records a one-time audit event', async () => {
    const reminder = {
      id: 'reminder-1',
      organizationId: 'org-1',
      bookingId: 'booking-1',
      status: 'failed',
      attempts: 10,
      updatedAt: now,
      lastError: 'provider unavailable',
      dueAt: now,
    };
    const prisma = {
      appointmentReminder: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([reminder])
          .mockResolvedValueOnce([]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValue({ count: 0 }),
      },
    };
    const service = new AppointmentReminderRecoveryService(
      audit as never,
      config as never,
      prisma as never,
      queue as never,
    ) as unknown as { recover(): Promise<void> };

    await service.recover();

    expect(prisma.appointmentReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Jest asymmetric matchers are typed as any.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ status: 'dead_letter' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'appointment.reminder_dead_lettered',
        entityId: reminder.bookingId,
      }),
    );
  });

  it('dead-letters a terminal calendar sync and records an audit event', async () => {
    const event = {
      id: 'calendar-event-1',
      organizationId: 'org-1',
      bookingId: 'booking-1',
      connectionId: 'connection-1',
      operation: 'upsert',
      status: 'failed',
      attempts: 10,
      updatedAt: now,
      lastError: 'provider unavailable',
    };
    const prisma = {
      appointmentCalendarEvent: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([event])
          .mockResolvedValueOnce([]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValue({ count: 0 }),
      },
    };
    const service = new AppointmentCalendarRecoveryService(
      audit as never,
      { calendarJobId: jest.fn() } as never,
      config as never,
      prisma as never,
      queue as never,
    ) as unknown as { recover(): Promise<void> };

    await service.recover();

    expect(prisma.appointmentCalendarEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ status: 'dead_letter' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'appointment.calendar_sync_dead_lettered',
        entityId: event.bookingId,
      }),
    );
  });
});
