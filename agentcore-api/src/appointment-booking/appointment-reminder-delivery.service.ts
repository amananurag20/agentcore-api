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
    const message = this.buildMessage(booking, reminderType);
    const deliveries: Array<() => Promise<ReminderDeliveryResult | null>> = [];

    if (
      channels.has('email') &&
      booking.customerEmail &&
      !alreadyDelivered.has('email')
    ) {
      deliveries.push(() => this.sendEmail(booking, message));
    }
    if (
      channels.has('sms') &&
      booking.customerPhone &&
      !alreadyDelivered.has('sms')
    ) {
      deliveries.push(() => this.sendSms(booking.customerPhone!, message));
    }
    if (
      channels.has('whatsapp') &&
      booking.customerPhone &&
      !alreadyDelivered.has('whatsapp')
    ) {
      deliveries.push(() =>
        this.sendWhatsApp(
          booking.organizationId,
          booking.customerPhone!,
          booking,
          message,
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

  private async sendEmail(
    booking: ReminderBooking,
    message: string,
  ): Promise<ReminderDeliveryResult | null> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    const from = this.configService.get<string>('APPOINTMENT_EMAIL_FROM');
    if (!apiKey || !from || !booking.customerEmail) return null;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [booking.customerEmail],
        subject: `Appointment: ${booking.service.name}`,
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
  ): Promise<ReminderDeliveryResult | null> {
    const config = await this.prisma.whatsAppAssistantConfig.findFirst({
      where: { organizationId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    if (!config?.accessTokenEncrypted || !config.phoneNumberId) return null;

    if (config.provider === 'meta') {
      return this.sendMetaWhatsApp(config, to, booking);
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
  ): Promise<ReminderDeliveryResult> {
    const token = this.cryptoService.decrypt(config.accessTokenEncrypted!);
    const templateName =
      this.configService.get<string>('APPOINTMENT_WHATSAPP_TEMPLATE_NAME') ??
      'appointment_reminder';
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

  private buildMessage(booking: ReminderBooking, reminderType: string): string {
    const prefix =
      reminderType === 'confirmation'
        ? 'Your appointment is confirmed.'
        : 'This is an appointment reminder.';
    return `${prefix} ${booking.service.name} with ${booking.staff.name} is scheduled for ${this.formatStart(booking)}.`;
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
