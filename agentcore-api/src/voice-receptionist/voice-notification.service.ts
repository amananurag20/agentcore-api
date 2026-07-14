import { Injectable, Logger } from '@nestjs/common';
import { Prisma, VoiceCall, VoiceReceptionistConfig } from '@prisma/client';
import { AppointmentReminderDeliveryService } from '../appointment-booking/appointment-reminder-delivery.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VoiceNotificationService {
  private readonly logger = new Logger(VoiceNotificationService.name);

  constructor(
    private readonly deliveryService: AppointmentReminderDeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  async notifyHandoff(
    config: VoiceReceptionistConfig,
    call: VoiceCall,
    reason = 'A caller requested a human agent.',
  ) {
    return this.notify(
      config,
      call,
      'Voice call needs an agent',
      reason,
      'handoff',
    );
  }

  async notifyVoicemail(
    config: VoiceReceptionistConfig,
    call: VoiceCall,
    recordingUrl: string,
    transcript?: string,
  ) {
    const detail = transcript
      ? `Transcript: ${transcript}`
      : `Recording: ${recordingUrl}`;
    return this.notify(
      config,
      call,
      'New voice receptionist voicemail',
      detail,
      'voicemail',
    );
  }

  private async notify(
    config: VoiceReceptionistConfig,
    call: VoiceCall,
    subject: string,
    detail: string,
    kind: 'handoff' | 'voicemail',
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: call.organizationId },
      select: {
        contactEmail: true,
        users: {
          where: { isActive: true, roles: { hasSome: ['org_admin', 'agent'] } },
          select: { email: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    const settings = this.toRecord(config.settings);
    const emailSetting = settings[`${kind}NotificationEmail`];
    const phoneSetting = settings[`${kind}NotificationPhone`];
    const email =
      typeof emailSetting === 'string'
        ? emailSetting
        : (organization?.contactEmail ?? organization?.users[0]?.email);
    const phone = typeof phoneSetting === 'string' ? phoneSetting : undefined;
    const caller = call.fromNumber ?? call.callerName ?? 'Unknown caller';
    const message = `${detail}\nCaller: ${caller}\nCall ID: ${call.id}`;

    try {
      return await this.deliveryService.deliverTransactional({
        email,
        phone,
        subject,
        message,
      });
    } catch (error) {
      this.logger.error(
        `Voice ${kind} notification failed for call=${call.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      return [];
    }
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    return value;
  }
}
