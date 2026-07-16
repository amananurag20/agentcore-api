import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentBooking,
  AppointmentService,
  AppointmentStaff,
  Prisma,
  WhatsAppAssistantConfig,
} from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type ReminderBooking = AppointmentBooking & {
  service: AppointmentService;
  staff: AppointmentStaff;
};

export type ReminderDeliveryResult = {
  channel: 'email' | 'sms' | 'whatsapp';
  provider: string;
  providerMessageId?: string;
};

@Injectable()
export class AppointmentReminderDeliveryService {
  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  async deliver(
    booking: ReminderBooking,
    reminderType: string,
    alreadyDelivered: ReadonlySet<string> = new Set(),
    onDelivered?: (result: ReminderDeliveryResult) => Promise<void>,
  ): Promise<ReminderDeliveryResult[]> {
    const channels = this.getChannels();
    const suppressed = await this.getSuppressedChannels(booking);
    const content = await this.buildContent(booking, reminderType);
    const deliveries: Array<() => Promise<ReminderDeliveryResult | null>> = [];

    if (
      channels.has('email') &&
      booking.customerEmail &&
      !alreadyDelivered.has('email') &&
      !suppressed.has('email')
    ) {
      deliveries.push(() =>
        this.sendEmail(booking, content.message, content.emailSubject),
      );
    }
    if (
      channels.has('sms') &&
      booking.customerPhone &&
      !alreadyDelivered.has('sms') &&
      !suppressed.has('sms')
    ) {
      deliveries.push(() =>
        this.sendSms(booking.customerPhone!, content.message),
      );
    }
    if (
      channels.has('whatsapp') &&
      booking.customerPhone &&
      !alreadyDelivered.has('whatsapp') &&
      !suppressed.has('whatsapp')
    ) {
      deliveries.push(() =>
        this.sendWhatsApp(
          booking.organizationId,
          booking.customerPhone!,
          booking,
          content.message,
          content.whatsAppTemplateName,
        ),
      );
    }

    const results: ReminderDeliveryResult[] = [];
    for (const deliver of deliveries) {
      const result = await deliver();
      if (!result) continue;
      results.push(result);
      await onDelivered?.(result);
    }
    return results;
  }

  async deliverTransactional(input: {
    email?: string | null;
    phone?: string | null;
    subject: string;
    message: string;
  }): Promise<ReminderDeliveryResult[]> {
    const results: ReminderDeliveryResult[] = [];
    if (input.email) {
      const email = await this.sendEmailMessage(
        input.email,
        input.subject,
        input.message,
      );
      if (email) results.push(email);
    }
    if (input.phone) {
      const sms = await this.sendSms(input.phone, input.message);
      if (sms) results.push(sms);
    }
    return results;
  }

  reminderOptOutToken(booking: Pick<ReminderBooking, 'id' | 'organizationId'>) {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
    return createHmac('sha256', secret)
      .update(`${booking.organizationId}:${booking.id}:reminder-opt-out`)
      .digest('base64url');
  }

  verifyReminderOptOutToken(
    booking: Pick<ReminderBooking, 'id' | 'organizationId'>,
    token: string,
  ): boolean {
    const expected = Buffer.from(this.reminderOptOutToken(booking));
    const supplied = Buffer.from(token);
    return (
      expected.length === supplied.length && timingSafeEqual(expected, supplied)
    );
  }

  private async sendEmail(
    booking: ReminderBooking,
    message: string,
    subject: string,
  ): Promise<ReminderDeliveryResult | null> {
    if (!booking.customerEmail) return null;
    return this.sendEmailMessage(booking.customerEmail, subject, message);
  }

  private async sendEmailMessage(
    to: string,
    subject: string,
    message: string,
  ): Promise<ReminderDeliveryResult | null> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    const from = this.configService.get<string>('APPOINTMENT_EMAIL_FROM');
    if (!apiKey || !from) return null;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: message,
      }),
      signal: this.providerTimeoutSignal(),
    });
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.message ?? `Email provider returned ${response.status}`,
      );
    }
    return { channel: 'email', provider: 'resend', providerMessageId: body.id };
  }

  private async sendSms(
    to: string,
    message: string,
  ): Promise<ReminderDeliveryResult | null> {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    const from = this.configService.get<string>('TWILIO_SMS_FROM');
    if (!accountSid || !authToken || !from) return null;

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: message }),
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.message ?? `SMS provider returned ${response.status}`,
      );
    }
    return { channel: 'sms', provider: 'twilio', providerMessageId: body.sid };
  }

  private async sendWhatsApp(
    organizationId: string,
    to: string,
    booking: ReminderBooking,
    fallbackMessage: string,
    templateName?: string,
  ): Promise<ReminderDeliveryResult | null> {
    const config = await this.prisma.whatsAppAssistantConfig.findFirst({
      where: { organizationId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    if (!config?.accessTokenEncrypted || !config.phoneNumberId) return null;

    if (config.provider === 'meta') {
      return this.sendMetaWhatsApp(config, to, booking, templateName);
    }
    if (config.provider === 'twilio') {
      return this.sendTwilioWhatsApp(config, to, fallbackMessage);
    }
    return null;
  }

  private async sendMetaWhatsApp(
    config: WhatsAppAssistantConfig,
    to: string,
    booking: ReminderBooking,
    configuredTemplateName?: string,
  ): Promise<ReminderDeliveryResult> {
    const token = this.cryptoService.decrypt(config.accessTokenEncrypted!);
    const templateName =
      configuredTemplateName ||
      (this.configService.get<string>('APPOINTMENT_WHATSAPP_TEMPLATE_NAME') ??
        'appointment_reminder');
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: config.defaultLocale || 'en' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: booking.customerName },
                  { type: 'text', text: booking.service.name },
                  { type: 'text', text: this.formatStart(booking) },
                  { type: 'text', text: booking.staff.name },
                ],
              },
            ],
          },
        }),
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(
        body.error?.message ?? `WhatsApp provider returned ${response.status}`,
      );
    }
    return {
      channel: 'whatsapp',
      provider: 'meta',
      providerMessageId: body.messages?.[0]?.id,
    };
  }

  private async sendTwilioWhatsApp(
    config: WhatsAppAssistantConfig,
    to: string,
    message: string,
  ): Promise<ReminderDeliveryResult> {
    if (!config.businessAccountId) {
      throw new Error('Twilio WhatsApp account SID is missing');
    }
    const authToken = this.cryptoService.decrypt(config.accessTokenEncrypted!);
    const auth = Buffer.from(
      `${config.businessAccountId}:${authToken}`,
    ).toString('base64');
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.businessAccountId}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: `whatsapp:${config.phoneNumberId}`,
          To: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
          Body: message,
        }),
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.message ?? `WhatsApp provider returned ${response.status}`,
      );
    }
    return {
      channel: 'whatsapp',
      provider: 'twilio',
      providerMessageId: body.sid,
    };
  }

  private async buildContent(
    booking: ReminderBooking,
    reminderType: string,
  ): Promise<{
    message: string;
    emailSubject: string;
    whatsAppTemplateName?: string;
  }> {
    const policy = await this.prisma.appointmentBookingPolicy.findUnique({
      where: { organizationId: booking.organizationId },
      select: { reminderTemplates: true },
    });
    const templates = {
      ...this.toStringRecord(policy?.reminderTemplates),
      ...this.toStringRecord(booking.service.reminderTemplates),
    };
    const defaultTemplate =
      reminderType === 'confirmation'
        ? 'Your appointment is confirmed. {{serviceName}} with {{staffName}} is scheduled for {{startTime}}.'
        : 'Appointment reminder: {{serviceName}} with {{staffName}} is scheduled for {{startTime}}.';
    const template =
      reminderType === 'confirmation'
        ? templates.confirmation || defaultTemplate
        : templates[reminderType] || templates.reminder || defaultTemplate;
    const publicUrl = this.configService.get<string>('APPOINTMENT_PUBLIC_URL');
    let preferencesUrl = '';
    if (publicUrl) {
      const url = new URL('/book', publicUrl);
      url.searchParams.set('organizationId', booking.organizationId);
      url.searchParams.set('bookingId', booking.id);
      url.searchParams.set('token', this.reminderOptOutToken(booking));
      url.searchParams.set('channel', 'email');
      preferencesUrl = url.toString();
    }
    const variables: Record<string, string> = {
      customerName: booking.customerName,
      serviceName: booking.service.name,
      staffName: booking.staff.name,
      startTime: this.formatStart(booking),
      partySize: String(booking.partySize),
      reminderType,
      preferencesUrl,
    };
    const render = (value: string) =>
      value.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(variables, key)
          ? variables[key]
          : match,
      );
    const rendered = render(template);
    return {
      message:
        preferencesUrl && !template.includes('{{preferencesUrl}}')
          ? `${rendered} Manage reminder preferences: ${preferencesUrl}`
          : rendered,
      emailSubject: render(
        templates.emailSubject || 'Appointment: {{serviceName}}',
      ),
      whatsAppTemplateName: templates.whatsappTemplateName,
    };
  }

  private toStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private async getSuppressedChannels(
    booking: ReminderBooking,
  ): Promise<Set<string>> {
    const contacts = [
      booking.customerEmail?.trim().toLowerCase(),
      booking.customerPhone?.replace(/\s+/g, ''),
    ].filter((value): value is string => Boolean(value));
    if (!contacts.length) return new Set();
    const suppressions =
      await this.prisma.appointmentReminderSuppression.findMany({
        where: {
          organizationId: booking.organizationId,
          contactNormalized: { in: contacts },
        },
        select: { channel: true },
      });
    return new Set(suppressions.map((item) => item.channel));
  }

  private formatStart(booking: ReminderBooking): string {
    return new Intl.DateTimeFormat('en', {
      timeZone: booking.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(booking.startAt);
  }

  private getChannels(): Set<string> {
    const raw =
      this.configService.get<string>('APPOINTMENT_REMINDER_CHANNELS') ??
      'email,sms,whatsapp';
    return new Set(raw.split(',').map((value) => value.trim().toLowerCase()));
  }

  private providerTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(
      this.configService.get<number>('APPOINTMENT_PROVIDER_TIMEOUT_MS', 10_000),
    );
  }

  toProviderMessageIds(
    results: ReminderDeliveryResult[],
  ): Prisma.InputJsonObject {
    return Object.fromEntries(
      results.map((result) => [
        result.channel,
        result.providerMessageId ?? result.provider,
      ]),
    );
  }
}
