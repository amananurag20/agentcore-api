import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppointmentBookingService } from './appointment-booking.service';

describe('AppointmentBookingService concurrency errors', () => {
  const prisma = { $transaction: jest.fn() };
  const service = new AppointmentBookingService(
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
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
