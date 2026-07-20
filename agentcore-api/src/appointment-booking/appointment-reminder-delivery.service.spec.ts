import { AppointmentReminderDeliveryService } from './appointment-reminder-delivery.service';

describe('AppointmentReminderDeliveryService templates', () => {
  it('merges service templates over organization defaults and renders variables', async () => {
    const prisma = {
      appointmentBookingPolicy: {
        findUnique: jest.fn().mockResolvedValue({
          reminderTemplates: {
            reminder: 'Organization reminder for {{serviceName}}',
            emailSubject: 'Upcoming {{serviceName}}',
          },
        }),
      },
    };
    const service = new AppointmentReminderDeliveryService(
      { get: jest.fn() } as never,
      {} as never,
      prisma as never,
    ) as unknown as {
      buildContent(
        booking: unknown,
        reminderType: string,
      ): Promise<{ message: string; emailSubject: string }>;
    };

    const content = await service.buildContent(
      {
        id: 'booking-1',
        organizationId: 'org-1',
        customerName: 'Ada',
        partySize: 2,
        startAt: new Date('2026-08-01T10:00:00.000Z'),
        timezone: 'UTC',
        service: {
          name: 'Consultation',
          reminderTemplates: {
            reminder:
              'Hi {{customerName}}, {{partySize}} seats for {{serviceName}} at {{startTime}}.',
          },
        },
        staff: { name: 'Grace' },
      },
      '1h_before',
    );

    expect(content.message).toContain('Hi Ada, 2 seats for Consultation');
    expect(content.emailSubject).toBe('Upcoming Consultation');
  });

  it('does not send transactional waitlist messages through opted-out channels', async () => {
    const prisma = {
      appointmentReminderSuppression: {
        findMany: jest.fn().mockResolvedValue([
          { channel: 'email', contactNormalized: 'ada@example.com' },
          { channel: 'sms', contactNormalized: '+15551234567' },
        ]),
      },
    };
    const service = new AppointmentReminderDeliveryService(
      {
        get: jest.fn((key: string) =>
          key === 'RESEND_API_KEY' || key === 'APPOINTMENT_EMAIL_FROM'
            ? 'configured'
            : undefined,
        ),
      } as never,
      {} as never,
      prisma as never,
    );
    const originalFetch = global.fetch;
    global.fetch = jest.fn();

    try {
      await expect(
        service.deliverTransactional({
          organizationId: 'org-1',
          email: 'Ada@Example.com',
          phone: '+15551234567',
          subject: 'Waitlist offer',
          message: 'A slot is available',
        }),
      ).resolves.toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
