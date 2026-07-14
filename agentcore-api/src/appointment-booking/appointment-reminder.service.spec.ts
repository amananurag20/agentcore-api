import { AppointmentReminderService } from './appointment-reminder.service';

describe('AppointmentReminderService', () => {
  const booking = {
    id: 'booking-1',
    organizationId: 'org-1',
    status: 'confirmed',
    startAt: new Date(Date.now() + 60 * 60_000),
    service: { name: 'Consultation' },
    staff: { name: 'Ada' },
  };
  const reminder = {
    id: 'reminder-1',
    dueAt: new Date('2026-07-14T09:00:00.000Z'),
    reminderType: '1h_before',
    status: 'pending',
    channels: [] as string[],
    providerMessageIds: {},
    booking,
  };
  const prisma = {
    appointmentReminder: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const delivery = { deliver: jest.fn() };
  const service = new AppointmentReminderService(
    { record: jest.fn() } as never,
    delivery as never,
    prisma as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.appointmentReminder.findUnique.mockResolvedValue({ ...reminder });
    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });
    prisma.appointmentReminder.update.mockResolvedValue({});
  });

  it('checkpoints a successful channel before another channel fails', async () => {
    delivery.deliver.mockImplementation(
      async (
        _booking: unknown,
        _type: string,
        _alreadyDelivered: Set<string>,
        onDelivered: (result: unknown) => Promise<void>,
      ) => {
        await onDelivered({
          channel: 'email',
          provider: 'resend',
          providerMessageId: 'email-1',
        });
        throw new Error('SMS provider unavailable');
      },
    );

    await expect(
      service.processReminder({
        reminderId: reminder.id,
        expectedDueAt: reminder.dueAt.toISOString(),
      }),
    ).rejects.toThrow('SMS provider unavailable');

    expect(prisma.appointmentReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // Jest asymmetric matchers are typed as any.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          channels: ['email'],
          providerMessageIds: { email: 'email-1' },
        }),
      }),
    );
    expect(prisma.appointmentReminder.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('passes completed channels to delivery on retry', async () => {
    prisma.appointmentReminder.findUnique.mockResolvedValue({
      ...reminder,
      channels: ['email'],
      providerMessageIds: { email: 'email-1' },
    });
    delivery.deliver.mockResolvedValue([]);

    await service.processReminder({
      reminderId: reminder.id,
      expectedDueAt: reminder.dueAt.toISOString(),
    });

    expect(delivery.deliver).toHaveBeenCalledWith(
      booking,
      reminder.reminderType,
      new Set(['email']),
      expect.any(Function),
    );
    expect(prisma.appointmentReminder.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: 'sent',
          channels: ['email'],
        }),
      }),
    );
  });

  it('skips a delayed job after the appointment has started', async () => {
    prisma.appointmentReminder.findUnique.mockResolvedValue({
      ...reminder,
      booking: {
        ...booking,
        startAt: new Date(Date.now() - 60_000),
      },
    });

    await service.processReminder({
      reminderId: reminder.id,
      expectedDueAt: reminder.dueAt.toISOString(),
    });

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(prisma.appointmentReminder.update).toHaveBeenLastCalledWith({
      where: { id: reminder.id },
      data: {
        status: 'skipped',
        lastError: 'Appointment has already started',
      },
    });
  });
});
