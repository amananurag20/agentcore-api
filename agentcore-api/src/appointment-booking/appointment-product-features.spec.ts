import { AppointmentNoShowService } from './appointment-no-show.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';

describe('Appointment product feature workers', () => {
  it('marks an unchecked-in confirmed booking as no-show after its grace window', async () => {
    const booking = {
      id: 'booking-1',
      organizationId: 'org-1',
      status: 'confirmed' as const,
      checkedInAt: null,
      endAt: new Date(Date.now() - 60 * 60_000),
    };
    type StatusInput = { where: { status: { in: string[] } } };
    type UpdateInput = StatusInput & { data: { status: string } };
    let capturedFind: StatusInput | undefined;
    let capturedUpdate: UpdateInput | undefined;
    const findMany = jest.fn((input: StatusInput) => {
      capturedFind = input;
      return Promise.resolve([booking]);
    });
    const updateMany = jest.fn((input: UpdateInput) => {
      capturedUpdate = input;
      return Promise.resolve({ count: 1 });
    });
    const prisma = {
      appointmentBooking: {
        findMany,
        updateMany,
      },
      appointmentBookingPolicy: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { organizationId: 'org-1', noShowGraceMinutes: 30 },
          ]),
      },
      appointmentRecurrenceSeries: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const audit = { record: jest.fn() };
    const calendar = { scheduleBookingSync: jest.fn() };
    const reminders = { cancelBookingReminders: jest.fn() };
    const service = new AppointmentNoShowService(
      audit as never,
      calendar as never,
      { get: jest.fn() } as never,
      prisma as never,
      reminders as never,
    ) as unknown as { scan(): Promise<void> };

    await service.scan();

    expect(capturedFind?.where.status.in).toEqual(['pending', 'confirmed']);
    expect(capturedUpdate?.where.status.in).toEqual(['pending', 'confirmed']);
    expect(capturedUpdate?.data.status).toBe('no_show');
    expect(reminders.cancelBookingReminders).toHaveBeenCalledWith(booking.id);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'appointment.booking_auto_no_show' }),
    );
  });

  it('moves a reminder out of configured overnight quiet hours', async () => {
    const prisma = {
      appointmentReminder: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        upsert: jest.fn(({ create }: { create: { dueAt: Date } }) =>
          Promise.resolve({ id: `reminder-${create.dueAt.toISOString()}` }),
        ),
        update: jest.fn(),
      },
      appointmentBookingPolicy: {
        findUnique: jest.fn().mockResolvedValue({
          quietHoursEnabled: true,
          quietHoursStart: '21:00',
          quietHoursEnd: '08:00',
          quietHoursTimezone: 'UTC',
          reminderOffsetsMinutes: [840],
        }),
      },
    };
    const queue = {
      isEnabled: jest.fn(() => true),
      add: jest.fn(),
      remove: jest.fn(),
    };
    const service = new AppointmentReminderQueueService(
      { get: jest.fn() } as never,
      prisma as never,
      queue as never,
    );

    await service.enqueueBookingReminders({
      bookingId: 'booking-1',
      organizationId: 'org-1',
      startAt: new Date('2026-08-02T12:00:00.000Z'),
      timezone: 'UTC',
    });

    const reminderCreates = prisma.appointmentReminder.upsert.mock.calls.map(
      ([input]) => input.create as { offsetMinutes: number; dueAt: Date },
    );
    expect(
      reminderCreates.find((item) => item.offsetMinutes === 840)?.dueAt,
    ).toEqual(new Date('2026-08-02T08:00:00.000Z'));
  });

  it('uses a service reminder schedule before the organization default', async () => {
    const prisma = {
      appointmentReminder: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        upsert: jest.fn(({ create }: { create: { offsetMinutes: number } }) =>
          Promise.resolve({ id: `reminder-${create.offsetMinutes}` }),
        ),
        update: jest.fn(),
      },
      appointmentBookingPolicy: {
        findUnique: jest.fn().mockResolvedValue({
          quietHoursEnabled: false,
          reminderOffsetsMinutes: [1440, 60],
        }),
      },
      appointmentService: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ reminderOffsetsMinutes: [30] }),
      },
    };
    const queue = {
      isEnabled: jest.fn(() => true),
      add: jest.fn(),
      remove: jest.fn(),
    };
    const service = new AppointmentReminderQueueService(
      { get: jest.fn() } as never,
      prisma as never,
      queue as never,
    );

    await service.enqueueBookingReminders({
      bookingId: 'booking-1',
      organizationId: 'org-1',
      serviceId: 'service-1',
      startAt: new Date(Date.now() + 2 * 60 * 60_000),
      timezone: 'UTC',
    });

    const offsets = prisma.appointmentReminder.upsert.mock.calls.map(
      ([input]) => input.create.offsetMinutes,
    );
    expect(offsets).toEqual([30, 0]);
  });
});
