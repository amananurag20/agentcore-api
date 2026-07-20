import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppointmentBookingService } from './appointment-booking.service';
import { AppointmentTimezoneService } from './appointment-timezone.service';

describe('AppointmentBookingService concurrency errors', () => {
  const prisma = { $transaction: jest.fn() };
  const service = new AppointmentBookingService(
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
  );
  const runSerializable = service as unknown as {
    runSerializable<T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T>;
  };

  beforeEach(() => jest.clearAllMocks());

  it('maps PostgreSQL 23P01 exclusion violations from unknown Prisma errors to 409', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'Raw query failed. Code: 23P01. conflicting key value violates exclusion constraint "appointment_bookings_active_staff_no_overlap"',
        { clientVersion: Prisma.prismaVersion.client },
      ),
    );

    await expect(
      runSerializable.runSerializable(() => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a nested database error code from Prisma metadata to 409', async () => {
    prisma.$transaction.mockRejectedValue({
      message: 'Database constraint failed',
      meta: { code: '23P01' },
    });

    await expect(
      runSerializable.runSerializable(() => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AppointmentBookingService schedule range', () => {
  const prisma = {
    organizationProduct: {
      findFirst: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
    },
  };
  const service = new AppointmentBookingService(
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
  );
  const user = { orgId: 'org-1', roles: ['org_admin'] } as never;

  it('rejects an inverted schedule range', async () => {
    await expect(
      service.listSchedule(user, {
        from: '2026-08-02T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps schedule queries at 63 days', async () => {
    await expect(
      service.listSchedule(user, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-04-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AppointmentBookingService group capacity', () => {
  const startAt = new Date('2026-08-01T10:00:00.000Z');
  const endAt = new Date('2026-08-01T10:30:00.000Z');
  const serviceRecord = {
    id: 'service-1',
    organizationId: 'org-1',
    name: 'Group class',
    description: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceCents: null,
    currency: 'USD',
    maxAttendees: 3,
    cancellationWindowMinutes: null,
    rescheduleWindowMinutes: null,
    waitlistEnabled: true,
    reminderOffsetsMinutes: [],
    reminderTemplates: {},
    status: 'active' as const,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    appointmentBooking: {
      findFirst: jest.fn().mockResolvedValue({ id: 'existing-1' }),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'existing-1',
          serviceId: 'service-1',
          staffId: 'staff-1',
          startAt,
          endAt,
          partySize: 2,
          service: serviceRecord,
        },
      ]),
    },
    appointmentStaffTimeOff: { findFirst: jest.fn().mockResolvedValue(null) },
    appointmentBlackout: { findMany: jest.fn().mockResolvedValue([]) },
    appointmentServiceResource: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const bookingService = new AppointmentBookingService(
    {} as never,
    { hasExternalConflict: jest.fn().mockResolvedValue(false) } as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
  ) as unknown as {
    hasConflict(input: {
      organizationId: string;
      service: typeof serviceRecord;
      staffId: string;
      startAt: Date;
      endAt: Date;
      partySize: number;
    }): Promise<boolean>;
  };

  it('allows seats that fit and rejects a party that exceeds remaining seats', async () => {
    await expect(
      bookingService.hasConflict({
        organizationId: 'org-1',
        service: serviceRecord,
        staffId: 'staff-1',
        startAt,
        endAt,
        partySize: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      bookingService.hasConflict({
        organizationId: 'org-1',
        service: serviceRecord,
        staffId: 'staff-1',
        startAt,
        endAt,
        partySize: 2,
      }),
    ).resolves.toBe(true);
  });
});

describe('AppointmentBookingService availability snapshots', () => {
  it('skips a DST-gap window and does not issue conflict queries per slot', async () => {
    const serviceRecord = {
      id: 'service-1',
      organizationId: 'org-1',
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxAttendees: 1,
      status: 'active',
    };
    const prisma = {
      appointmentService: {
        findFirst: jest.fn().mockResolvedValue(serviceRecord),
      },
      appointmentStaff: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'staff-1',
            name: 'Ada',
            timezone: 'America/New_York',
            availability: [
              { dayOfWeek: 0, startTime: '02:30', endTime: '03:00' },
              { dayOfWeek: 0, startTime: '03:30', endTime: '04:00' },
            ],
          },
        ]),
      },
      appointmentBlackout: { findMany: jest.fn().mockResolvedValue([]) },
      appointmentServiceResource: { findMany: jest.fn().mockResolvedValue([]) },
      appointmentBooking: { findMany: jest.fn().mockResolvedValue([]) },
      appointmentStaffTimeOff: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const bookingService = new AppointmentBookingService(
      {} as never,
      { listExternalBusyIntervals: jest.fn().mockResolvedValue([]) } as never,
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'APPOINTMENT_MAX_ADVANCE_DAYS' ? 1000 : fallback,
        ),
      } as never,
      {} as never,
      {} as never,
      prisma as never,
      new AppointmentTimezoneService(),
    ) as unknown as {
      listAvailableSlots(
        organizationId: string,
        input: { serviceId: string; date: string; timezone: string },
      ): Promise<Array<{ startAt: Date }>>;
    };

    const slots = await bookingService.listAvailableSlots('org-1', {
      serviceId: 'service-1',
      date: '2027-03-14',
      timezone: 'America/New_York',
    });

    expect(slots.map((slot) => slot.startAt.toISOString())).toEqual([
      '2027-03-14T07:30:00.000Z',
    ]);
    expect(prisma.appointmentBooking.findMany).toHaveBeenCalledTimes(1);
  });
});
