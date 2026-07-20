import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceAgentAvailability } from '@prisma/client';
import twilio from 'twilio';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceAgentAvailabilityDto } from './dto/voice-receptionist.dto';

@Injectable()
export class VoiceSoftphoneService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async getState(currentUser: AuthenticatedUser) {
    this.assertAgent(currentUser);
    const user = await this.prisma.user.findFirst({
      where: { id: currentUser.sub, orgId: currentUser.orgId, isActive: true },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new NotFoundException('Voice agent account not found');

    const config = await this.prisma.voiceReceptionistConfig.findFirst({
      where: {
        organizationId: currentUser.orgId,
        provider: 'twilio',
        status: 'active',
      },
      orderBy: { createdAt: 'asc' },
    });
    const identity = this.identityForUser(user.id);
    const presence = await this.prisma.voiceAgentPresence.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        organizationId: currentUser.orgId,
        clientIdentity: identity,
      },
      update: { clientIdentity: identity },
    });
    const normalizedAvailability = this.isPresenceFresh(presence.lastSeenAt)
      ? presence.availability
      : VoiceAgentAvailability.offline;
    if (normalizedAvailability !== presence.availability) {
      await this.prisma.voiceAgentPresence.update({
        where: { id: presence.id },
        data: { availability: normalizedAvailability, activeCallId: null },
      });
    }

    const credentials = config ? this.credentials(config.settings) : null;
    const configured = Boolean(config && credentials);
    const token = credentials
      ? this.createToken(credentials, identity)
      : undefined;
    const pendingCalls = await this.prisma.voiceCall.findMany({
      where: {
        organizationId: currentUser.orgId,
        assignedAgentId: user.id,
        status: { in: ['waiting_for_agent', 'transferred', 'in_progress'] },
      },
      select: {
        id: true,
        callerName: true,
        fromNumber: true,
        status: true,
        summary: true,
        startedAt: true,
      },
      orderBy: { lastEventAt: 'desc' },
      take: 10,
    });

    return {
      configured,
      configId: config?.id,
      identity,
      token,
      tokenTtlSeconds: this.tokenTtlSeconds(),
      availability: normalizedAvailability,
      activeCallId: presence.activeCallId,
      pendingCalls,
      message: configured
        ? undefined
        : 'Set TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID, and an active Twilio voice configuration.',
    };
  }

  async setPresence(
    currentUser: AuthenticatedUser,
    availability: VoiceAgentAvailabilityDto,
  ) {
    this.assertAgent(currentUser);
    const identity = this.identityForUser(currentUser.sub);
    const presence = await this.prisma.voiceAgentPresence.upsert({
      where: { userId: currentUser.sub },
      create: {
        userId: currentUser.sub,
        organizationId: currentUser.orgId,
        clientIdentity: identity,
        availability,
      },
      update: {
        availability,
        lastSeenAt: new Date(),
        ...(availability === VoiceAgentAvailabilityDto.offline
          ? { activeCallId: null }
          : {}),
      },
    });
    return {
      availability: presence.availability,
      identity: presence.clientIdentity,
      lastSeenAt: presence.lastSeenAt,
    };
  }

  async heartbeat(currentUser: AuthenticatedUser) {
    this.assertAgent(currentUser);
    const presence = await this.prisma.voiceAgentPresence.findUnique({
      where: { userId: currentUser.sub },
    });
    if (!presence) {
      return this.setPresence(currentUser, VoiceAgentAvailabilityDto.offline);
    }
    const updated = await this.prisma.voiceAgentPresence.update({
      where: { id: presence.id },
      data: { lastSeenAt: new Date() },
    });
    return {
      availability: updated.availability,
      identity: updated.clientIdentity,
      lastSeenAt: updated.lastSeenAt,
    };
  }

  async findAvailableAgent(
    organizationId: string,
    preferredUserId?: string | null,
  ) {
    const freshAfter = new Date(Date.now() - this.presenceTtlSeconds() * 1000);
    if (preferredUserId) {
      const preferred = await this.prisma.voiceAgentPresence.findFirst({
        where: {
          organizationId,
          userId: preferredUserId,
          availability: 'available',
          lastSeenAt: { gte: freshAfter },
          user: { isActive: true },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (preferred) return preferred;
    }
    return this.prisma.voiceAgentPresence.findFirst({
      where: {
        organizationId,
        availability: 'available',
        lastSeenAt: { gte: freshAfter },
        user: { isActive: true },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async markCallStatus(
    clientIdentity: string,
    callId: string | null,
    status: 'available' | 'busy',
  ): Promise<void> {
    await this.prisma.voiceAgentPresence.updateMany({
      where: { clientIdentity },
      data: {
        availability: status,
        activeCallId: callId,
        lastSeenAt: new Date(),
      },
    });
  }

  requireConfigured(): void {
    if (!this.globalCredentialsPresent()) {
      throw new ConflictException('Twilio browser softphone is not configured');
    }
  }

  private createToken(
    credentials: {
      accountSid: string;
      apiKeySid: string;
      apiKeySecret: string;
      twimlAppSid: string;
    },
    identity: string,
  ): string {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(
      credentials.accountSid,
      credentials.apiKeySid,
      credentials.apiKeySecret,
      { identity, ttl: this.tokenTtlSeconds() },
    );
    token.addGrant(
      new VoiceGrant({
        incomingAllow: true,
        outgoingApplicationSid: credentials.twimlAppSid,
      }),
    );
    return token.toJwt();
  }

  private credentials(settingsValue: unknown) {
    const settings = this.toRecord(settingsValue);
    const accountSid =
      (typeof settings.twilioAccountSid === 'string'
        ? settings.twilioAccountSid
        : undefined) ?? this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const apiKeySid = this.configService.get<string>('TWILIO_API_KEY_SID');
    const apiKeySecret = this.configService.get<string>(
      'TWILIO_API_KEY_SECRET',
    );
    const twimlAppSid = this.configService.get<string>('TWILIO_TWIML_APP_SID');
    return accountSid && apiKeySid && apiKeySecret && twimlAppSid
      ? { accountSid, apiKeySid, apiKeySecret, twimlAppSid }
      : null;
  }

  private globalCredentialsPresent(): boolean {
    return Boolean(
      this.configService.get<string>('TWILIO_API_KEY_SID') &&
      this.configService.get<string>('TWILIO_API_KEY_SECRET') &&
      this.configService.get<string>('TWILIO_TWIML_APP_SID'),
    );
  }

  private identityForUser(userId: string): string {
    return `agent_${userId.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 121);
  }

  private isPresenceFresh(lastSeenAt: Date): boolean {
    return (
      Date.now() - lastSeenAt.getTime() <= this.presenceTtlSeconds() * 1000
    );
  }

  private tokenTtlSeconds(): number {
    return this.configService.get<number>(
      'VOICE_AGENT_TOKEN_TTL_SECONDS',
      3600,
    );
  }

  private presenceTtlSeconds(): number {
    return this.configService.get<number>(
      'VOICE_AGENT_PRESENCE_TTL_SECONDS',
      90,
    );
  }

  private assertAgent(currentUser: AuthenticatedUser): void {
    if (
      !currentUser.roles.some((role) =>
        ['agent', 'org_admin', 'product_admin', 'super_admin'].includes(role),
      )
    ) {
      throw new ForbiddenException('Voice agent access is required');
    }
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
