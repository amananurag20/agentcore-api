import { createTransport } from 'nodemailer';
import { AppointmentReminderDeliveryService } from './appointment-reminder-delivery.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('AppointmentReminderDeliveryService templates', () => {
  beforeEach(() => {
    jest.mocked(createTransport).mockReset();
  });

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
      { get: jest.fn() } as never,
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

  it('sends appointment email through the configured SMTP transport', async () => {
    const sendMail = jest
      .fn()
      .mockResolvedValue({ messageId: 'smtp-message-1' });
    jest.mocked(createTransport).mockReturnValue({ sendMail } as never);
    const config = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USER: 'appointments@example.com',
      SMTP_PASSWORD: 'secret',
      APPOINTMENT_EMAIL_FROM: 'Appointments <appointments@example.com>',
      APPOINTMENT_PROVIDER_TIMEOUT_MS: 12_000,
    };
    const service = new AppointmentReminderDeliveryService(
      { get: jest.fn((key: keyof typeof config) => config[key]) } as never,
      {} as never,
      {
        appointmentReminderSuppression: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as never,
    );

    await expect(
      service.deliverTransactional({
        organizationId: 'org-1',
        email: 'customer@example.com',
        subject: 'Appointment confirmed',
        message: 'Your appointment is confirmed.',
      }),
    ).resolves.toEqual([
      {
        channel: 'email',
        provider: 'smtp',
        providerMessageId: 'smtp-message-1',
      },
    ]);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'appointments@example.com', pass: 'secret' },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 12_000,
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Appointments <appointments@example.com>',
      to: 'customer@example.com',
      subject: 'Appointment confirmed',
      text: 'Your appointment is confirmed.',
    });
  });
});
