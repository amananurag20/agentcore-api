import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import sanitizeHtml from 'sanitize-html';
import {
  AppointmentBooking,
  AppointmentService,
  AppointmentStaff,
  Prisma,
  WhatsAppAssistantConfig,
} from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { APPLICATION_DEFAULTS } from '../config/application-defaults';
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
  private emailTransporter?: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  async getNotificationReadiness(organizationId: string): Promise<{
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
  }> {
    const whatsapp = await this.prisma.whatsAppAssistantConfig.findFirst({
      where: {
        organizationId,
        status: 'active',
        accessTokenEncrypted: { not: null },
        phoneNumberId: { not: null },
      },
      select: { id: true },
    });
    return {
      email: Boolean(
        this.configService.get<string>('APPOINTMENT_EMAIL_FROM') &&
          this.configService.get<string>('SMTP_HOST'),
      ),
      sms: Boolean(
        this.configService.get<string>('TWILIO_ACCOUNT_SID') &&
          this.configService.get<string>('TWILIO_AUTH_TOKEN') &&
          this.configService.get<string>('TWILIO_SMS_FROM'),
      ),
      whatsapp: Boolean(whatsapp),
    };
  }

  async deliver(
    booking: ReminderBooking,
    reminderType: string,
    alreadyDelivered: ReadonlySet<string> = new Set(),
    onDelivered?: (result: ReminderDeliveryResult) => Promise<void>,
  ): Promise<ReminderDeliveryResult[]> {
    const suppressed = await this.getSuppressedChannels(booking);
    const content = await this.buildContent(booking, reminderType);
    const channels = this.getChannels(content.reminderChannels);
    const deliveries: Array<() => Promise<ReminderDeliveryResult | null>> = [];

    if (
      channels.has('email') &&
      booking.customerEmail &&
      !alreadyDelivered.has('email') &&
      !suppressed.has('email')
    ) {
      deliveries.push(() =>
        this.sendEmail(
          booking,
          content.channelMessages.email,
          content.emailSubject,
          content.emailHtml,
        ),
      );
    }
    if (
      channels.has('sms') &&
      booking.customerPhone &&
      !alreadyDelivered.has('sms') &&
      !suppressed.has('sms')
    ) {
      deliveries.push(() =>
        this.sendSms(booking.customerPhone!, content.channelMessages.sms),
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
          content.channelMessages.whatsapp,
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
    organizationId?: string;
    email?: string | null;
    phone?: string | null;
    subject: string;
    message: string;
  }): Promise<ReminderDeliveryResult[]> {
    const results: ReminderDeliveryResult[] = [];
    const policy = input.organizationId
      ? await this.prisma.appointmentBookingPolicy.findUnique({
          where: { organizationId: input.organizationId },
          select: { reminderChannels: true },
        })
      : null;
    const enabledChannels = this.getChannels(policy?.reminderChannels);
    const contacts = [
      input.email?.trim().toLowerCase(),
      input.phone?.replace(/\s+/g, ''),
    ].filter((value): value is string => Boolean(value));
    const suppressions = input.organizationId
      ? await this.prisma.appointmentReminderSuppression.findMany({
          where: {
            organizationId: input.organizationId,
            contactNormalized: { in: contacts },
          },
          select: { channel: true, contactNormalized: true },
        })
      : [];
    const isSuppressed = (channel: string, contact?: string | null) =>
      Boolean(
        contact &&
        suppressions.some(
          (item) =>
            item.channel === channel &&
            item.contactNormalized ===
              (channel === 'email'
                ? contact.trim().toLowerCase()
                : contact.replace(/\s+/g, '')),
        ),
      );
    if (
      enabledChannels.has('email') &&
      input.email &&
      !isSuppressed('email', input.email)
    ) {
      const email = await this.sendEmailMessage(
        input.email,
        input.subject,
        input.message,
      );
      if (email) results.push(email);
    }
    if (
      enabledChannels.has('sms') &&
      input.phone &&
      !isSuppressed('sms', input.phone)
    ) {
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
    html?: string,
  ): Promise<ReminderDeliveryResult | null> {
    if (!booking.customerEmail) return null;
    return this.sendEmailMessage(booking.customerEmail, subject, message, html);
  }

  private async sendEmailMessage(
    to: string,
    subject: string,
    message: string,
    html?: string,
  ): Promise<ReminderDeliveryResult | null> {
    const from = this.configService.get<string>('APPOINTMENT_EMAIL_FROM');
    const transporter = this.getEmailTransporter();
    if (!from || !transporter) return null;

    const result = await transporter.sendMail({
      from,
      to,
      subject,
      text: message,
      ...(html ? { html } : {}),
    });
    return {
      channel: 'email',
      provider: 'smtp',
      providerMessageId: result.messageId || undefined,
    };
  }

  private getEmailTransporter(): Transporter<SMTPTransport.SentMessageInfo> | null {
    if (this.emailTransporter) return this.emailTransporter;
    const host = this.configService.get<string>('SMTP_HOST');
    if (!host) return null;

    const user = this.configService.get<string>('SMTP_USER');
    const password = this.configService.get<string>('SMTP_PASSWORD');
    if (Boolean(user) !== Boolean(password)) {
      throw new Error(
        'SMTP_USER and SMTP_PASSWORD must be configured together',
      );
    }

    const timeoutMs = this.configService.get<number>(
      'APPOINTMENT_PROVIDER_TIMEOUT_MS',
      10_000,
    );
    this.emailTransporter = createTransport({
      host,
      port:
        this.configService.get<number>('SMTP_PORT') ??
        APPLICATION_DEFAULTS.email.smtpPort,
      secure:
        this.configService.get<boolean>('SMTP_SECURE') ??
        APPLICATION_DEFAULTS.email.smtpSecure,
      auth: user && password ? { user, pass: password } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    return this.emailTransporter;
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
    channelMessages: Record<'email' | 'sms' | 'whatsapp', string>;
    emailSubject: string;
    emailHtml: string;
    reminderChannels?: string[];
    whatsAppTemplateName?: string;
  }> {
    const policy = await this.prisma.appointmentBookingPolicy.findUnique({
      where: { organizationId: booking.organizationId },
      select: { reminderTemplates: true, reminderChannels: true },
    });
    const templates = {
      ...this.toStringRecord(policy?.reminderTemplates),
      ...this.toStringRecord(booking.service.reminderTemplates),
    };
    const meetingType = booking.meetingType ?? booking.service.meetingType ?? 'online';
    const meetingDetails =
      meetingType === 'online'
        ? booking.meetingUrl
          ? `Join online: ${booking.meetingUrl}`
          : 'A calendar invitation with the online meeting link will follow.'
        : meetingType === 'in_person'
          ? booking.location
            ? `Location: ${booking.location}`
            : 'This is an in-person appointment.'
          : booking.location
            ? `Call details: ${booking.location}`
            : 'The team member will call you using the phone number on your booking.';
    const defaultTemplate =
      reminderType === 'confirmation'
        ? 'Your appointment is confirmed. {{serviceName}} with {{staffName}} is scheduled for {{startTime}}.'
        : 'Appointment reminder: {{serviceName}} with {{staffName}} is scheduled for {{startTime}}.';
    const template =
      reminderType === 'confirmation'
        ? templates.confirmation || defaultTemplate
        : templates[reminderType] || templates.reminder || defaultTemplate;
    const publicUrl = this.configService.get<string>('APPOINTMENT_PUBLIC_URL');
    const preferencesUrlFor = (channel: 'email' | 'sms' | 'whatsapp') => {
      if (!publicUrl) return '';
      const url = new URL('/book', publicUrl);
      url.searchParams.set('organizationId', booking.organizationId);
      url.searchParams.set('bookingId', booking.id);
      url.searchParams.set('token', this.reminderOptOutToken(booking));
      url.searchParams.set('channel', channel);
      return url.toString();
    };
    const baseVariables: Record<string, string> = {
      customerName: booking.customerName,
      serviceName: booking.service.name,
      staffName: booking.staff.name,
      startTime: this.formatStart(booking),
      partySize: String(booking.partySize),
      reminderType,
      meetingType,
      meetingProvider: booking.meetingProvider ?? '',
      meetingUrl: booking.meetingUrl ?? '',
      location: booking.location ?? '',
      meetingDetails,
    };
    const render = (
      value: string,
      channel: 'email' | 'sms' | 'whatsapp',
    ) => {
      const variables = {
        ...baseVariables,
        preferencesUrl: preferencesUrlFor(channel),
      };
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(variables, key)
          ? variables[key]
          : match,
      );
    };
    const channelTemplate = (
      channel: 'email' | 'sms' | 'whatsapp',
    ) => {
      const eventName =
        reminderType === 'confirmation' ? 'Confirmation' : 'Reminder';
      const specificEventName =
        reminderType === 'confirmation'
          ? ''
          : `${reminderType.charAt(0).toUpperCase()}${reminderType.slice(1)}`;
      return (
        (specificEventName
          ? templates[`${channel}${specificEventName}`]
          : undefined) ||
        templates[`${channel}${eventName}`] ||
        template
      );
    };
    const renderChannelMessage = (
      channel: 'email' | 'sms' | 'whatsapp',
    ) => {
      const selectedTemplate = channelTemplate(channel);
      const renderedMessage = render(selectedTemplate, channel);
      const messageWithMeetingDetails = /\{\{(meetingUrl|meetingDetails|location)\}\}/.test(
        selectedTemplate,
      )
        ? renderedMessage
        : `${renderedMessage} ${meetingDetails}`;
      const preferencesUrl = preferencesUrlFor(channel);
      return preferencesUrl && !selectedTemplate.includes('{{preferencesUrl}}')
        ? `${messageWithMeetingDetails} Manage reminder preferences: ${preferencesUrl}`
        : messageWithMeetingDetails;
    };
    const channelMessages = {
      email: renderChannelMessage('email'),
      sms: renderChannelMessage('sms'),
      whatsapp: renderChannelMessage('whatsapp'),
    };
    const emailTextTemplate = channelTemplate('email');
    const renderedEmailText = render(emailTextTemplate, 'email');
    const emailPreferencesUrl = preferencesUrlFor('email');
    const legacyRender = (value: string) =>
      value.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(baseVariables, key)
          ? baseVariables[key]
          : match,
      );
    const emailHtmlTemplate =
      reminderType === 'confirmation'
        ? templates.confirmationEmailHtml
        : templates[`${reminderType}EmailHtml`] || templates.reminderEmailHtml;
    const renderedEmailHtml = emailHtmlTemplate
      ? this.sanitizeEmailHtml(render(emailHtmlTemplate, 'email'))
      : this.plainTextEmailHtml(renderedEmailText);
    const emailHtmlWithMeetingDetails = /\{\{(meetingUrl|meetingDetails|location)\}\}/.test(
      emailHtmlTemplate ?? emailTextTemplate,
    )
      ? renderedEmailHtml
      : `${renderedEmailHtml}${
          booking.meetingUrl
            ? `<p><a href="${this.escapeHtml(booking.meetingUrl)}">Join online meeting</a></p>`
            : `<p>${this.escapeHtml(meetingDetails)}</p>`
        }`;
    const emailHtml =
      emailPreferencesUrl &&
      !(emailHtmlTemplate ?? '').includes('{{preferencesUrl}}')
        ? `${emailHtmlWithMeetingDetails}<p><a href="${this.escapeHtml(emailPreferencesUrl)}">Manage reminder preferences</a></p>`
        : emailHtmlWithMeetingDetails;
    return {
      message: legacyRender(template),
      channelMessages,
      emailSubject: render(
        templates.emailSubject || 'Appointment: {{serviceName}}',
        'email',
      ),
      emailHtml,
      reminderChannels: policy?.reminderChannels,
      whatsAppTemplateName: templates.whatsappTemplateName,
    };
  }

  private sanitizeEmailHtml(value: string): string {
    return sanitizeHtml(value, {
      allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        'h1',
        'h2',
        'h3',
        'ul',
        'ol',
        'li',
        'blockquote',
        'div',
        'span',
        'a',
      ],
      allowedAttributes: {
        a: ['href', 'target', 'rel'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        a: (_tagName, attributes) => ({
          tagName: 'a',
          attribs: {
            ...attributes,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        }),
      },
    });
  }

  private plainTextEmailHtml(value: string): string {
    return `<p>${this.escapeHtml(value).replace(/\r?\n/g, '<br>')}</p>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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

  private getChannels(organizationChannels?: string[]): Set<string> {
    const raw =
      this.configService.get<string>('APPOINTMENT_REMINDER_CHANNELS') ??
      'email,sms,whatsapp';
    const configuredChannels = new Set(
      raw.split(',').map((value) => value.trim().toLowerCase()),
    );
    const enabledChannels = organizationChannels ?? [...configuredChannels];
    return new Set(
      enabledChannels.filter((channel) => configuredChannels.has(channel)),
    );
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
