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
});
