import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Prisma, VoiceReceptionistConfig } from '@prisma/client';
import { ChatService } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { AppointmentBookingService } from '../appointment-booking/appointment-booking.service';
import { AppointmentActionDto } from '../appointment-booking/dto/appointment-action.dto';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignVoiceCallDto,
  BrowserHandoffDto,
  CreateVoiceConfigDto,
  ListVoiceCallsDto,
  RouteVoiceCallDto,
  SendVoiceAgentMessageDto,
  UpdateVoiceCallStatusDto,
  UpdateVoiceConfigDto,
  TwilioDialCallbackDto,
  TwilioConversationRelayCallbackDto,
  TwilioClientStatusCallbackDto,
  TwilioGatherCallbackDto,
  TwilioIncomingCallDto,
  TwilioRecordingCallbackDto,
  TwilioStatusCallbackDto,
  VoiceCallEventTypeDto,
  VoiceAgentAvailabilityDto,
  VoiceRouteActionDto,
  VoiceWebhookEventDto,
} from './dto/voice-receptionist.dto';
import {
  VoiceOutboundService,
  VoiceProviderActionResult,
} from './voice-outbound.service';
import { VoiceNotificationService } from './voice-notification.service';
import { VoiceRuntimeService } from './voice-runtime.service';
import { VoiceSoftphoneService } from './voice-softphone.service';

type VoiceCallWithEvents = Prisma.VoiceCallGetPayload<{
  include: {
    events: true;
  };
}>;

export type ConversationRelaySetup = {
  sessionId: string;
  callSid: string;
  from?: string;
  to?: string;
};

export type ConversationRelayPromptResult =
  | { type: 'text'; content: string; language?: string }
  | {
      type: 'end';
      handoffData: string;
    };

@Injectable()
export class VoiceReceptionistService {
  constructor(
    private readonly auditService: AuditService,
    private readonly appointmentBookingService: AppointmentBookingService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly knowledgeService: KnowledgeService,
    private readonly notificationService: VoiceNotificationService,
    private readonly outboundService: VoiceOutboundService,
    private readonly prisma: PrismaService,
    @Optional() private readonly runtimeService?: VoiceRuntimeService,
    @Optional() private readonly softphoneService?: VoiceSoftphoneService,
  ) {}

  async listConfigs(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertVoiceEnabled(organizationId);
    const configs = await this.prisma.voiceReceptionistConfig.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    return configs.map((config) => this.toConfigResponse(config));
  }

  async createConfig(
    currentUser: AuthenticatedUser,
    input: CreateVoiceConfigDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertVoiceEnabled(organizationId);
    this.validateSettings(input.settings);

    const config = await this.prisma.voiceReceptionistConfig.create({
      data: {
        organizationId,
        provider: input.provider ?? 'twilio',
        status: input.status ?? 'active',
        name: input.name,
        phoneNumber: input.phoneNumber,
        sipDomain: input.sipDomain,
        webhookVerifyTokenEncrypted: input.webhookVerifyToken
          ? this.cryptoService.encrypt(input.webhookVerifyToken)
          : undefined,
        apiKeyEncrypted: input.apiKey
          ? this.cryptoService.encrypt(input.apiKey)
          : undefined,
        sttProvider: input.sttProvider,
        sttModel: input.sttModel,
        ttsProvider: input.ttsProvider,
        ttsVoice: input.ttsVoice,
        defaultLocale: input.defaultLocale ?? 'en',
        transferPhoneNumber: input.transferPhoneNumber,
        voicemailEnabled: input.voicemailEnabled ?? true,
        settings: this.toJsonObject(input.settings),
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'voice.config_created',
      entityType: 'voice_config',
      entityId: config.id,
      metadata: {
        provider: config.provider,
        name: config.name,
      },
    });

    return this.toConfigResponse(config);
  }

  async updateConfig(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateVoiceConfigDto,
  ) {
    const existing = await this.findConfigForActor(currentUser, id);
    this.validateSettings(input.settings);

    const config = await this.prisma.voiceReceptionistConfig.update({
      where: { id: existing.id },
      data: {
        provider: input.provider,
        status: input.status,
        name: input.name,
        phoneNumber: input.phoneNumber,
        sipDomain: input.sipDomain,
        webhookVerifyTokenEncrypted:
          input.webhookVerifyToken === undefined
            ? undefined
            : input.webhookVerifyToken
              ? this.cryptoService.encrypt(input.webhookVerifyToken)
              : null,
        apiKeyEncrypted:
          input.apiKey === undefined
            ? undefined
            : input.apiKey
              ? this.cryptoService.encrypt(input.apiKey)
              : null,
        sttProvider: input.sttProvider,
        sttModel: input.sttModel,
        ttsProvider: input.ttsProvider,
        ttsVoice: input.ttsVoice,
        defaultLocale: input.defaultLocale,
        transferPhoneNumber: input.transferPhoneNumber,
        voicemailEnabled: input.voicemailEnabled,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'voice.config_updated',
      entityType: 'voice_config',
      entityId: config.id,
    });

    return this.toConfigResponse(config);
  }

  async deleteConfig(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findConfigForActor(currentUser, id);
    const activeCalls = await this.prisma.voiceCall.count({
      where: {
        configId: config.id,
        status: { in: ['ringing', 'in_progress', 'waiting_for_agent'] },
      },
    });
    if (activeCalls) {
      throw new ConflictException(
        'Cannot delete a voice config with active calls',
      );
    }
    await this.prisma.voiceReceptionistConfig.delete({
      where: { id: config.id },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'voice.config_deleted',
      entityType: 'voice_config',
      entityId: config.id,
    });
    return { deleted: true, id: config.id };
  }

  async testConfig(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findConfigForActor(currentUser, id);
    const settings = this.toRecord(config.settings);
    const checks = {
      active: config.status === 'active',
      credentials: Boolean(config.apiKeyEncrypted),
      accountSid: Boolean(
        settings.twilioAccountSid ||
        this.configService.get<string>('TWILIO_ACCOUNT_SID'),
      ),
      webhookBase: Boolean(
        this.configService.get<string>('VOICE_WEBHOOK_PUBLIC_BASE_URL'),
      ),
      streamingConfigured: this.outboundService.hasConversationRelay(config),
      transferConfigured: Boolean(config.transferPhoneNumber),
      voicemailEnabled: config.voicemailEnabled,
    };
    let providerTest: {
      provider: string;
      reachable: boolean;
      liveControlSupported: boolean;
      message?: string;
      accountSid?: string;
      accountStatus?: string;
    };
    try {
      providerTest = await this.outboundService.testConnection(config);
    } catch (error) {
      providerTest = {
        provider: config.provider,
        reachable: false,
        liveControlSupported: config.provider === 'twilio',
        message:
          error instanceof Error ? error.message : 'Provider test failed',
      };
    }
    return {
      configId: config.id,
      ready:
        checks.active &&
        checks.credentials &&
        (config.provider !== 'twilio' || checks.accountSid) &&
        checks.webhookBase &&
        providerTest.reachable,
      checks,
      providerTest,
      checkedAt: new Date(),
    };
  }

  async listCalls(currentUser: AuthenticatedUser, input: ListVoiceCallsDto) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertVoiceEnabled(organizationId);

    const where: Prisma.VoiceCallWhereInput = {
      organizationId,
      status: input.status,
    };

    if (input.search) {
      where.OR = [
        { providerCallId: { contains: input.search, mode: 'insensitive' } },
        { fromNumber: { contains: input.search, mode: 'insensitive' } },
        { toNumber: { contains: input.search, mode: 'insensitive' } },
        { callerName: { contains: input.search, mode: 'insensitive' } },
      ];
    }

    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const [total, calls] = await this.prisma.$transaction([
      this.prisma.voiceCall.count({ where }),
      this.prisma.voiceCall.findMany({
        where,
        include: this.callInclude(),
        orderBy: { lastEventAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: calls.map((call) => this.toCallResponse(call)),
      total,
      page,
      limit,
    };
  }

  async getCall(currentUser: AuthenticatedUser, id: string) {
    const call = await this.findCallForActor(currentUser, id);
    return this.toCallResponse(call);
  }

  async getRecording(currentUser: AuthenticatedUser, id: string) {
    const call = await this.findCallForActor(currentUser, id);
    if (!call.recordingUrl) {
      throw new NotFoundException('Voice recording not found');
    }
    const config = await this.prisma.voiceReceptionistConfig.findUniqueOrThrow({
      where: { id: call.configId },
    });
    return this.outboundService.downloadRecording(config, call.recordingUrl);
  }

  async getAnalytics(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertVoiceEnabled(organizationId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const calls = await this.prisma.voiceCall.findMany({
      where: { organizationId, startedAt: { gte: since } },
      select: {
        status: true,
        durationSeconds: true,
        events: { select: { type: true } },
      },
    });
    const count = (status: string) =>
      calls.filter((call) => call.status === status).length;
    const durations = calls
      .map((call) => call.durationSeconds)
      .filter((value): value is number => value !== null);
    const eventCount = (type: string) =>
      calls.reduce(
        (total, call) =>
          total + call.events.filter((event) => event.type === type).length,
        0,
      );
    return {
      periodDays: 30,
      totalCalls: calls.length,
      inProgress: count('in_progress'),
      completed: count('completed'),
      transferred: count('transferred'),
      voicemail: count('voicemail'),
      failed: count('failed'),
      waitingForAgent: count('waiting_for_agent'),
      averageDurationSeconds: durations.length
        ? Math.round(
            durations.reduce((total, duration) => total + duration, 0) /
              durations.length,
          )
        : 0,
      containmentRate: calls.length
        ? Math.round((count('completed') / calls.length) * 1000) / 10
        : 0,
      transferRate: calls.length
        ? Math.round((count('transferred') / calls.length) * 1000) / 10
        : 0,
      bargeIns: eventCount('barge_in'),
      assistantResponses: eventCount('assistant_response'),
      generatedAt: new Date(),
    };
  }

  async getRuntimeHealth(
    currentUser: AuthenticatedUser,
    configId?: string,
    requestedOrganizationId?: string,
  ) {
    const organizationId = configId
      ? (await this.findConfigForActor(currentUser, configId)).organizationId
      : this.resolveOrganizationId(currentUser, requestedOrganizationId);
    await this.assertVoiceEnabled(organizationId);
    return (
      this.runtimeService?.getHealth(configId, organizationId) ?? {
        status: 'disabled',
        transport: 'twilio-conversation-relay',
        activeSessions: 0,
        sessions: [],
        checkedAt: new Date(),
      }
    );
  }

  async streamEvents(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertVoiceEnabled(organizationId);
    if (!this.runtimeService) {
      throw new ConflictException('Voice realtime service is unavailable');
    }
    return this.runtimeService.streamOrganization(organizationId);
  }

  async getSoftphoneState(currentUser: AuthenticatedUser) {
    if (!this.softphoneService) {
      throw new ConflictException('Voice softphone service is unavailable');
    }
    await this.assertVoiceEnabled(currentUser.orgId);
    return this.softphoneService.getState(currentUser);
  }

  async updateAgentPresence(
    currentUser: AuthenticatedUser,
    availability: VoiceAgentAvailabilityDto,
  ) {
    if (!this.softphoneService) {
      throw new ConflictException('Voice softphone service is unavailable');
    }
    await this.assertVoiceEnabled(currentUser.orgId);
    return this.softphoneService.setPresence(currentUser, availability);
  }

  async heartbeatAgent(currentUser: AuthenticatedUser) {
    if (!this.softphoneService) {
      throw new ConflictException('Voice softphone service is unavailable');
    }
    await this.assertVoiceEnabled(currentUser.orgId);
    return this.softphoneService.heartbeat(currentUser);
  }

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendVoiceAgentMessageDto,
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const config = await this.prisma.voiceReceptionistConfig.findUniqueOrThrow({
      where: { id: call.configId },
    });
    const action = await this.outboundService.speakText({
      config,
      providerCallId: call.providerCallId,
      content: input.content,
    });

    const event = await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: call.organizationId,
        callId: call.id,
        type: 'assistant_response',
        role: 'agent',
        content: input.content,
        metadata: this.toJsonObject({
          action,
          agentId: currentUser.sub,
          agentEmail: currentUser.email,
        }),
      },
    });

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: call.status === 'completed' ? 'in_progress' : call.status,
        assignedAgentId: call.assignedAgentId ?? currentUser.sub,
        lastEventAt: new Date(),
      },
      include: this.callInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.agent_spoke',
      entityType: 'voice_call',
      entityId: call.id,
      metadata: { eventId: event.id },
    });
    this.publishCallUpdate(updated);

    return {
      call: this.toCallResponse(updated),
      event: this.toEventResponse(event),
      action,
    };
  }

  async assignCall(
    currentUser: AuthenticatedUser,
    id: string,
    input: AssignVoiceCallDto,
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const assignedAgentId = input.assignedAgentId ?? null;

    if (assignedAgentId) {
      await this.assertAssignableAgent(call.organizationId, assignedAgentId);
    }

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: { assignedAgentId },
      include: this.callInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.call_assigned',
      entityType: 'voice_call',
      entityId: call.id,
      metadata: { assignedAgentId },
    });
    this.publishCallUpdate(updated);

    return this.toCallResponse(updated);
  }

  async updateCallStatus(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateVoiceCallStatusDto,
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const isTerminal = ['completed', 'failed'].includes(input.status);

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: input.status,
        endedAt: isTerminal ? new Date() : undefined,
        lastEventAt: new Date(),
      },
      include: this.callInclude(),
    });

    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: call.organizationId,
        callId: call.id,
        type: isTerminal ? 'call_ended' : 'system',
        role: 'system',
        content: `Call status changed to ${input.status}`,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.status_updated',
      entityType: 'voice_call',
      entityId: call.id,
      metadata: { status: input.status },
    });
    this.publishCallUpdate(updated);

    return this.toCallResponse(updated);
  }

  async requestHandoff(
    currentUser: AuthenticatedUser,
    id: string,
    input: BrowserHandoffDto = {},
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const config = await this.prisma.voiceReceptionistConfig.findUniqueOrThrow({
      where: { id: call.configId },
    });
    const browserAgent = this.softphoneService
      ? await this.softphoneService.findAvailableAgent(
          call.organizationId,
          input.assignedAgentId ?? call.assignedAgentId,
        )
      : null;
    const summary = browserAgent
      ? await this.createHandoffSummary(config, call)
      : call.summary;
    let action = browserAgent
      ? await this.safeProviderAction(config.provider, () =>
          this.outboundService.transferCallToClient({
            config,
            providerCallId: call.providerCallId,
            clientIdentity: browserAgent.clientIdentity,
            callId: call.id,
          }),
        )
      : undefined;
    let transport: 'browser' | 'phone' | 'notification' = browserAgent
      ? 'browser'
      : 'notification';
    if (action?.status !== 'sent' && config.transferPhoneNumber) {
      action = await this.safeProviderAction(config.provider, () =>
        this.outboundService.transferCall({
          config,
          providerCallId: call.providerCallId,
          transferTo: config.transferPhoneNumber,
        }),
      );
      transport = 'phone';
    }
    const connected = action?.status === 'sent';
    const fallbackAgent = connected
      ? null
      : await this.prisma.user.findFirst({
          where: {
            orgId: call.organizationId,
            isActive: true,
            roles: { hasSome: ['agent', 'org_admin'] },
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
    const notifications = connected
      ? []
      : await this.notificationService.notifyHandoff(config, call);

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: connected ? 'transferred' : 'waiting_for_agent',
        assignedAgentId:
          (connected && transport === 'browser'
            ? browserAgent?.userId
            : undefined) ??
          call.assignedAgentId ??
          fallbackAgent?.id,
        summary,
        lastEventAt: new Date(),
      },
      include: this.callInclude(),
    });

    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: call.organizationId,
        callId: call.id,
        type: 'route_decision',
        role: 'system',
        content: connected
          ? `Human handoff initiated through ${transport}.`
          : 'Human handoff requested; agents notified.',
        metadata: this.toJsonObject({
          action,
          notifications,
          transport,
          browserAgentId: browserAgent?.userId,
          summary,
        }),
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.handoff_requested',
      entityType: 'voice_call',
      entityId: call.id,
    });
    this.publishCallUpdate(updated);

    return this.toCallResponse(updated);
  }

  async routeCall(
    currentUser: AuthenticatedUser,
    id: string,
    input: RouteVoiceCallDto,
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const config = await this.prisma.voiceReceptionistConfig.findUniqueOrThrow({
      where: { id: call.configId },
    });

    let action: VoiceProviderActionResult;
    let status: 'transferred' | 'voicemail' | 'completed';
    if (input.action === VoiceRouteActionDto.transfer) {
      action = await this.outboundService.transferCall({
        config,
        providerCallId: call.providerCallId,
        transferTo: input.transferTo ?? config.transferPhoneNumber,
      });
      status = 'transferred';
    } else if (input.action === VoiceRouteActionDto.voicemail) {
      action = await this.outboundService.sendToVoicemail({
        config,
        providerCallId: call.providerCallId,
      });
      status = 'voicemail';
    } else {
      action = await this.outboundService.hangupCall({
        config,
        providerCallId: call.providerCallId,
        content: 'Thank you for calling. Goodbye.',
      });
      status = 'completed';
    }

    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: call.organizationId,
        callId: call.id,
        type:
          input.action === VoiceRouteActionDto.transfer
            ? 'transfer_requested'
            : input.action === VoiceRouteActionDto.voicemail
              ? 'voicemail'
              : 'call_ended',
        role: 'system',
        content: input.reason ?? `Route action: ${input.action}`,
        metadata: this.toJsonObject({ action, transferTo: input.transferTo }),
      },
    });

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status,
        endedAt: status === 'completed' ? new Date() : undefined,
        lastEventAt: new Date(),
      },
      include: this.callInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.call_routed',
      entityType: 'voice_call',
      entityId: call.id,
      metadata: { routeAction: input.action, providerAction: action },
    });
    this.publishCallUpdate(updated);

    return {
      call: this.toCallResponse(updated),
      action,
    };
  }

  async verifyWebhook(
    configId: string,
    verifyToken?: string,
    challenge?: string,
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertVoiceEnabled(config.organizationId);

    if (!config.webhookVerifyTokenEncrypted || !verifyToken) {
      throw new ForbiddenException(
        'Voice webhook verify token is not configured',
      );
    }
    const expectedToken = this.cryptoService.decrypt(
      config.webhookVerifyTokenEncrypted,
    );
    if (!this.secureCompareText(expectedToken, verifyToken)) {
      throw new ForbiddenException('Invalid voice webhook verify token');
    }

    return challenge ?? 'ok';
  }

  async handleWebhookEvent(
    configId: string,
    input: VoiceWebhookEventDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertVoiceEnabled(config.organizationId);
    this.assertWebhookSignature(config, input, rawBody, headers, requestUrl);

    const now = new Date();
    const call = await this.upsertCall(config, input, now);
    const inboundEvent = await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: input.eventType,
        role: this.roleForEvent(input.eventType),
        content: input.content,
        confidence: input.confidence,
        audioUrl: input.audioUrl,
        metadata: this.toJsonObject(input.metadata),
      },
    });

    let assistantEvent: Prisma.VoiceCallEventGetPayload<object> | null = null;
    let action:
      VoiceProviderActionResult | { provider: 'mock'; status: string } = {
      provider: 'mock',
      status: 'received',
    };

    if (input.eventType === VoiceCallEventTypeDto.call_started) {
      const routing = this.evaluateBusinessHours(config);
      if (!routing.isOpen) {
        action = config.voicemailEnabled
          ? await this.safeProviderAction(config.provider, () =>
              this.outboundService.sendToVoicemail({
                config,
                providerCallId: call.providerCallId,
              }),
            )
          : await this.safeProviderAction(config.provider, () =>
              this.outboundService.hangupCall({
                config,
                providerCallId: call.providerCallId,
                content: this.getSettingString(
                  config,
                  'afterHoursMessage',
                  'We are currently closed. Please call again during business hours.',
                ),
              }),
            );
        await this.recordRouteDecision(
          call.id,
          config.organizationId,
          config.voicemailEnabled
            ? 'Outside business hours. Sending to voicemail.'
            : 'Outside business hours. Playing the closed message.',
          action,
        );
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: {
            status:
              action.status === 'failed'
                ? 'failed'
                : config.voicemailEnabled
                  ? 'voicemail'
                  : 'completed',
            endedAt:
              action.status === 'failed' || !config.voicemailEnabled
                ? new Date()
                : undefined,
            lastEventAt: new Date(),
          },
        });
      } else {
        const greeting = this.getSettingString(
          config,
          'greeting',
          'Hello, thank you for calling. How can I help you today?',
        );
        action = await this.safeProviderAction(config.provider, () =>
          this.outboundService.speakText({
            config,
            providerCallId: call.providerCallId,
            content: greeting,
          }),
        );
        await this.prisma.voiceCallEvent.create({
          data: {
            organizationId: config.organizationId,
            callId: call.id,
            type: 'assistant_response',
            role: 'assistant',
            content: greeting,
            metadata: this.toJsonObject({ greeting: true, action }),
          },
        });
      }
    }

    if (
      input.eventType === VoiceCallEventTypeDto.transcript &&
      input.content &&
      ['ringing', 'in_progress'].includes(call.status)
    ) {
      const route = this.matchKeywordRoute(config, input.content);
      if (route) {
        action = await this.safeProviderAction(config.provider, () =>
          this.outboundService.transferCall({
            config,
            providerCallId: call.providerCallId,
            transferTo: route.transferTo,
          }),
        );
        await this.recordRouteDecision(
          call.id,
          config.organizationId,
          `Routing caller to ${route.department}.`,
          action,
        );
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: {
            status: action.status === 'failed' ? 'in_progress' : 'transferred',
            lastEventAt: new Date(),
          },
        });
      } else {
        const assistantReply = await this.createAssistantReply(
          config,
          call,
          input.content,
          this.readAppointmentAction(input.metadata),
        );
        assistantEvent = assistantReply.event;
        action = assistantReply.action;
      }
    }

    if (input.eventType === VoiceCallEventTypeDto.barge_in) {
      action = await this.safeProviderAction(config.provider, () =>
        this.outboundService.interruptCall({
          config,
          providerCallId: call.providerCallId,
        }),
      );
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'route_decision',
          role: 'system',
          content: 'Caller interrupted active TTS playback.',
          metadata: this.toJsonObject({ interrupt: true, action }),
        },
      });
    }

    if (input.eventType === VoiceCallEventTypeDto.call_ended) {
      const providerStatus =
        typeof input.metadata?.providerStatus === 'string'
          ? input.metadata.providerStatus
          : undefined;
      const failed = ['busy', 'canceled', 'failed', 'no-answer'].includes(
        providerStatus ?? '',
      );
      const rawDuration = input.metadata?.durationSeconds;
      const durationSeconds =
        typeof rawDuration === 'number'
          ? Math.max(0, Math.floor(rawDuration))
          : typeof rawDuration === 'string'
            ? this.parseOptionalInt(rawDuration)
            : undefined;
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: {
          status: failed ? 'failed' : 'completed',
          endedAt: now,
          durationSeconds,
          lastEventAt: now,
          summary: input.content,
          metadata: this.toJsonObject({
            ...this.toRecord(call.metadata),
            ...input.metadata,
            ...(providerStatus ? { providerStatus } : {}),
          }),
        },
      });
    }

    const updatedCall = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: { lastEventAt: new Date() },
      include: this.callInclude(),
    });

    await this.auditService.record({
      organizationId: config.organizationId,
      action: 'voice.webhook_event_received',
      entityType: 'voice_call',
      entityId: call.id,
      metadata: {
        providerCallId: input.providerCallId,
        eventType: input.eventType,
        inboundEventId: inboundEvent.id,
        assistantEventId: assistantEvent?.id,
      },
    });

    return {
      call: this.toCallResponse(updatedCall),
      inboundEvent: this.toEventResponse(inboundEvent),
      assistantEvent: assistantEvent
        ? this.toEventResponse(assistantEvent)
        : null,
      action,
    };
  }

  async handleTwilioIncoming(
    configId: string,
    input: TwilioIncomingCallDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): Promise<string> {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.upsertCall(
      config,
      {
        providerCallId: input.CallSid,
        fromNumber: input.From,
        toNumber: input.To,
        callerName: input.CallerName,
        eventType: VoiceCallEventTypeDto.call_started,
      },
      new Date(),
    );
    if (!call.events.some((event) => event.type === 'call_started')) {
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'call_started',
          role: 'system',
          content: 'Twilio call connected.',
        },
      });
    }

    if (!this.evaluateBusinessHours(config).isOpen) {
      if (config.voicemailEnabled) {
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: { status: 'voicemail', lastEventAt: new Date() },
        });
        return this.outboundService.buildVoicemailTwiml(config);
      }
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: { status: 'completed', endedAt: new Date() },
      });
      return this.outboundService.buildCloseTwiml(
        config,
        this.getSettingString(
          config,
          'afterHoursMessage',
          'We are currently closed. Please call again during business hours.',
        ),
      );
    }

    const greeting = this.getSettingString(
      config,
      'greeting',
      'Hello, thank you for calling. How can I help you today?',
    );
    const useConversationRelay =
      this.outboundService.hasConversationRelay(config);
    const greetingPlayed = call.events.some(
      (event) => this.toRecord(event.metadata).greeting === true,
    );
    if (!greetingPlayed) {
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'assistant_response',
          role: 'assistant',
          content: greeting,
          metadata: this.toJsonObject({
            greeting: true,
            delivery: useConversationRelay ? 'conversation-relay' : 'twiml',
          }),
        },
      });
    }
    if (useConversationRelay) {
      return this.outboundService.buildConversationRelayTwiml(config, greeting);
    }
    return this.outboundService.buildGatherTwiml(config, greeting);
  }

  async authorizeConversationRelay(
    configId: string,
    signature: string | undefined,
  ): Promise<VoiceReceptionistConfig> {
    const config = await this.findActiveConfig(configId);
    await this.assertVoiceEnabled(config.organizationId);
    const required = this.configService.get<boolean>(
      'VOICE_WEBHOOK_SIGNATURE_REQUIRED',
      true,
    );
    if (!required && !signature) return config;
    if (!signature || !config.apiKeyEncrypted) {
      throw new ForbiddenException('Invalid Twilio WebSocket signature');
    }
    const requestUrl = this.outboundService.getConversationRelayUrl(config);
    if (!requestUrl) {
      throw new ForbiddenException('ConversationRelay URL is not configured');
    }
    const expected = createHmac(
      'sha1',
      this.cryptoService.decrypt(config.apiKeyEncrypted),
    )
      .update(requestUrl)
      .digest('base64');
    if (!this.secureCompareText(expected, signature)) {
      throw new ForbiddenException('Invalid Twilio WebSocket signature');
    }
    return config;
  }

  async handleConversationRelaySetup(
    config: VoiceReceptionistConfig,
    input: ConversationRelaySetup,
  ): Promise<void> {
    const call = await this.findOrCreateCallbackCall(config, input.callSid);
    await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        fromNumber: input.from,
        toNumber: input.to,
        status: 'in_progress',
        lastEventAt: new Date(),
        metadata: this.toJsonObject({
          ...this.toRecord(call.metadata),
          conversationRelaySessionId: input.sessionId,
          transport: 'conversation-relay',
        }),
      },
    });
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'system',
        role: 'system',
        content: 'ConversationRelay streaming session connected.',
        metadata: this.toJsonObject({ sessionId: input.sessionId }),
      },
    });
  }

  async handleConversationRelayPrompt(
    config: VoiceReceptionistConfig,
    callSid: string,
    content: string,
    digits?: string,
    language?: string,
  ): Promise<ConversationRelayPromptResult> {
    const call = await this.findCallByProvider(config.id, callSid);
    const normalizedContent = content.trim();
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'transcript',
        role: 'caller',
        content: normalizedContent,
        metadata: this.toJsonObject({
          transport: 'conversation-relay',
          digits,
          language,
        }),
      },
    });
    const route = digits
      ? this.matchDtmfRoute(config, digits)
      : this.matchKeywordRoute(config, normalizedContent);
    if (route) {
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'transfer_requested',
          role: 'system',
          content: `Routing caller to ${route.department}.`,
          metadata: this.toJsonObject({
            transferTo: route.transferTo,
            transport: 'conversation-relay',
          }),
        },
      });
      return {
        type: 'end',
        handoffData: JSON.stringify({
          action: 'transfer',
          transferTo: route.transferTo,
        }),
      };
    }

    if (!digits && this.isHumanHandoffRequest(normalizedContent)) {
      const browserHandoff = await this.prepareBrowserHandoff(config, call.id);
      if (browserHandoff) {
        return {
          type: 'end',
          handoffData: JSON.stringify({
            action: 'client',
            clientIdentity: browserHandoff.clientIdentity,
            callId: call.id,
          }),
        };
      }
      if (config.transferPhoneNumber) {
        return {
          type: 'end',
          handoffData: JSON.stringify({
            action: 'transfer',
            transferTo: config.transferPhoneNumber,
          }),
        };
      }
      if (config.voicemailEnabled) {
        return {
          type: 'end',
          handoffData: JSON.stringify({ action: 'voicemail' }),
        };
      }
    }

    const reply = await this.createAssistantReply(
      config,
      call,
      normalizedContent,
      undefined,
      'inline',
    );
    return {
      type: 'text',
      content: reply.event.content ?? 'How else can I help?',
      language,
    };
  }

  async handleConversationRelayInterrupt(
    config: VoiceReceptionistConfig,
    callSid: string,
    utteranceUntilInterrupt?: string,
    durationUntilInterruptMs?: number,
  ): Promise<void> {
    const call = await this.findCallByProvider(config.id, callSid);
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'barge_in',
        role: 'caller',
        content: utteranceUntilInterrupt,
        metadata: this.toJsonObject({
          transport: 'conversation-relay',
          durationUntilInterruptMs,
        }),
      },
    });
  }

  async handleTwilioConversationRelayCallback(
    configId: string,
    input: TwilioConversationRelayCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): Promise<string> {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.findOrCreateCallbackCall(config, input.CallSid);
    const handoff = this.parseConversationRelayHandoff(input.HandoffData);
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'system',
        role: 'system',
        content: `ConversationRelay session ${input.SessionStatus ?? 'ended'}.`,
        metadata: this.toJsonObject({
          sessionId: input.SessionId,
          sessionDurationSeconds: this.parseOptionalInt(input.SessionDuration),
          errorCode: input.ErrorCode,
          errorMessage: input.ErrorMessage,
          handoff,
        }),
      },
    });
    if (handoff?.action === 'transfer' && handoff.transferTo) {
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: { status: 'transferred', lastEventAt: new Date() },
      });
      return this.outboundService.buildTransferTwiml(
        config,
        handoff.transferTo,
      );
    }
    if (
      handoff?.action === 'client' &&
      handoff.clientIdentity &&
      handoff.callId === call.id
    ) {
      return this.outboundService.buildClientTransferTwiml(
        config,
        handoff.clientIdentity,
        call.id,
      );
    }
    if (handoff?.action === 'voicemail' && config.voicemailEnabled) {
      return this.outboundService.buildVoicemailTwiml(config);
    }
    if (input.SessionStatus === 'failed' || input.ErrorCode) {
      return this.outboundService.buildGatherTwiml(
        config,
        'I am sorry, the live voice connection was interrupted. How can I help?',
      );
    }
    return '<Response><Hangup/></Response>';
  }

  async handleTwilioGather(
    configId: string,
    input: TwilioGatherCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): Promise<string> {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.findCallByProvider(config.id, input.CallSid);
    const idempotencyKey = this.getHeader(
      headers,
      'i-twilio-idempotency-token',
    );
    if (idempotencyKey) {
      const prior = await this.prisma.voiceCallEvent.findFirst({
        where: {
          callId: call.id,
          metadata: { path: ['idempotencyKey'], equals: idempotencyKey },
        },
      });
      const priorResponse = prior
        ? this.toRecord(prior.metadata).responseTwiml
        : undefined;
      if (typeof priorResponse === 'string') return priorResponse;
    }
    if (['completed', 'failed', 'voicemail'].includes(call.status)) {
      return this.outboundService.buildCloseTwiml(config, 'Goodbye.');
    }
    const content = input.SpeechResult?.trim() || input.Digits?.trim();
    if (!content) {
      return this.outboundService.buildGatherTwiml(
        config,
        'I did not catch that. How can I help?',
      );
    }
    const inboundEvent = await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'transcript',
        role: 'caller',
        content,
        confidence: this.parseOptionalFloat(input.Confidence),
        metadata: this.toJsonObject({ digits: input.Digits, idempotencyKey }),
      },
    });
    const route = input.Digits
      ? this.matchDtmfRoute(config, input.Digits)
      : this.matchKeywordRoute(config, content);
    if (route) {
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'transfer_requested',
          role: 'system',
          content: `Routing caller to ${route.department}.`,
          metadata: this.toJsonObject({ transferTo: route.transferTo }),
        },
      });
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: { status: 'transferred', lastEventAt: new Date() },
      });
      const twiml = this.outboundService.buildTransferTwiml(
        config,
        route.transferTo,
      );
      await this.storeTwilioResponse(inboundEvent, twiml);
      return twiml;
    }

    if (!input.Digits && this.isHumanHandoffRequest(content)) {
      const browserHandoff = await this.prepareBrowserHandoff(config, call.id);
      const twiml = browserHandoff
        ? this.outboundService.buildClientTransferTwiml(
            config,
            browserHandoff.clientIdentity,
            call.id,
          )
        : config.transferPhoneNumber
          ? this.outboundService.buildTransferTwiml(
              config,
              config.transferPhoneNumber,
            )
          : config.voicemailEnabled
            ? this.outboundService.buildVoicemailTwiml(config)
            : this.outboundService.buildGatherTwiml(
                config,
                'No human agent is available right now. How else can I help?',
              );
      if (!browserHandoff && config.transferPhoneNumber) {
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: { status: 'transferred', lastEventAt: new Date() },
        });
      } else if (
        !browserHandoff &&
        !config.transferPhoneNumber &&
        config.voicemailEnabled
      ) {
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: { status: 'voicemail', lastEventAt: new Date() },
        });
      }
      await this.storeTwilioResponse(inboundEvent, twiml);
      return twiml;
    }

    const reply = await this.createAssistantReply(
      config,
      call,
      content,
      undefined,
      'inline',
    );
    const twiml = this.outboundService.buildGatherTwiml(
      config,
      reply.event.content ?? 'How else can I help?',
    );
    await this.storeTwilioResponse(inboundEvent, twiml);
    return twiml;
  }

  async handleTwilioStatus(
    configId: string,
    input: TwilioStatusCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ) {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.findOrCreateCallbackCall(config, input.CallSid);
    const status = this.mapTwilioCallStatus(input.CallStatus);
    const terminal = status === 'completed' || status === 'failed';
    const durationSeconds = this.parseOptionalInt(input.CallDuration);
    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status,
        durationSeconds,
        endedAt: terminal ? new Date() : undefined,
        lastEventAt: new Date(),
        metadata: this.toJsonObject({
          ...this.toRecord(call.metadata),
          providerStatus: input.CallStatus,
        }),
      },
      include: this.callInclude(),
    });
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: terminal ? 'call_ended' : 'system',
        role: 'system',
        content: `Twilio call status: ${input.CallStatus}`,
        metadata: this.toJsonObject({ durationSeconds }),
      },
    });
    this.publishCallUpdate(updated);
    return this.toCallResponse(updated);
  }

  async handleTwilioDial(
    configId: string,
    input: TwilioDialCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): Promise<string> {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.findCallByProvider(config.id, input.CallSid);
    const answered = input.DialCallStatus === 'completed';
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'route_decision',
        role: 'system',
        content: `Transfer result: ${input.DialCallStatus}`,
        metadata: this.toJsonObject({
          dialDurationSeconds: this.parseOptionalInt(input.DialCallDuration),
        }),
      },
    });
    if (answered) {
      const updated = await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: {
          status: 'completed',
          endedAt: new Date(),
          lastEventAt: new Date(),
        },
      });
      this.publishCallUpdate(updated);
      return '<Response><Hangup/></Response>';
    }
    if (config.voicemailEnabled) {
      const updated = await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: { status: 'voicemail', lastEventAt: new Date() },
      });
      this.publishCallUpdate(updated);
      return this.outboundService.buildVoicemailTwiml(config);
    }
    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: { status: 'in_progress', lastEventAt: new Date() },
    });
    this.publishCallUpdate(updated);
    return this.outboundService.buildGatherTwiml(
      config,
      'No one is available right now. Would you like help with something else?',
    );
  }

  async handleTwilioClientStatus(
    configId: string,
    input: TwilioClientStatusCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ) {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const parentCallSid = input.ParentCallSid ?? input.CallSid;
    const call = await this.findCallByProvider(config.id, parentCallSid);
    const clientIdentity = input.To?.replace(/^client:/, '');
    const answered = input.CallStatus === 'answered';
    if (clientIdentity && this.softphoneService) {
      await this.softphoneService.markCallStatus(
        clientIdentity,
        answered ? call.id : null,
        answered ? 'busy' : 'available',
      );
    }
    if (answered) {
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: { status: 'in_progress', lastEventAt: new Date() },
      });
    }
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'system',
        role: 'system',
        content: `Browser agent call status: ${input.CallStatus}`,
        metadata: this.toJsonObject({
          clientIdentity,
          childCallSid: input.CallSid,
        }),
      },
    });
    this.publishCallUpdate(call);
    return { received: true };
  }

  async handleTwilioRecording(
    configId: string,
    input: TwilioRecordingCallbackDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): Promise<string> {
    const config = await this.loadSignedTwilioConfig(
      configId,
      rawBody,
      headers,
      requestUrl,
    );
    const call = await this.findCallByProvider(config.id, input.CallSid);
    const recordingDurationSeconds = this.parseOptionalInt(
      input.RecordingDuration,
    );
    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: 'voicemail',
        recordingSid: input.RecordingSid,
        recordingUrl: input.RecordingUrl,
        recordingDurationSeconds,
        lastEventAt: new Date(),
      },
    });
    this.publishCallUpdate(updated);
    const existingEvent = await this.prisma.voiceCallEvent.findFirst({
      where: {
        callId: call.id,
        type: 'voicemail',
        metadata: { path: ['recordingSid'], equals: input.RecordingSid },
      },
    });
    const previousMetadata = existingEvent
      ? this.toRecord(existingEvent.metadata)
      : {};
    const eventData = {
      content: input.TranscriptionText,
      audioUrl: input.RecordingUrl,
      metadata: this.toJsonObject({
        ...previousMetadata,
        recordingSid: input.RecordingSid,
        recordingStatus: input.RecordingStatus,
        recordingDurationSeconds,
        transcriptionStatus: input.TranscriptionStatus,
      }),
    };
    const savedEvent = existingEvent
      ? await this.prisma.voiceCallEvent.update({
          where: { id: existingEvent.id },
          data: eventData,
        })
      : await this.prisma.voiceCallEvent.create({
          data: {
            organizationId: config.organizationId,
            callId: call.id,
            type: 'voicemail',
            role: 'caller',
            ...eventData,
          },
        });
    if (
      previousMetadata.notificationSent !== true &&
      (input.RecordingStatus === 'completed' || input.TranscriptionText)
    ) {
      const notifications = await this.notificationService.notifyVoicemail(
        config,
        call,
        input.RecordingUrl,
        input.TranscriptionText,
      );
      await this.prisma.voiceCallEvent.update({
        where: { id: savedEvent.id },
        data: {
          metadata: this.toJsonObject({
            ...this.toRecord(savedEvent.metadata),
            notificationSent: true,
            notifications,
          }),
        },
      });
    }
    return this.outboundService.buildCloseTwiml(
      config,
      'Thank you. Your message has been recorded. Goodbye.',
    );
  }

  private async createAssistantReply(
    config: VoiceReceptionistConfig,
    call: VoiceCallWithEvents,
    content: string,
    appointmentAction?: AppointmentActionDto,
    delivery: 'provider' | 'inline' = 'provider',
  ): Promise<{
    event: Prisma.VoiceCallEventGetPayload<object>;
    action: VoiceProviderActionResult;
  }> {
    if (appointmentAction) {
      let answer: string;
      let appointmentError: string | undefined;
      try {
        const result = await this.appointmentBookingService.executeAction(
          config.organizationId,
          appointmentAction,
        );
        answer = this.appointmentBookingService.formatActionResult(result);
      } catch (error) {
        appointmentError =
          error instanceof Error ? error.message : 'Appointment action failed';
        answer = this.getSettingString(
          config,
          'errorMessage',
          'I am sorry, I could not complete that appointment request. Please try again or ask for a person.',
        );
      }
      const action = await this.deliverAssistantReply(
        config,
        call,
        answer,
        delivery,
      );
      const event = await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'assistant_response',
          role: 'assistant',
          content: answer,
          metadata: this.toJsonObject({
            appointmentAction,
            action,
            ...(appointmentError ? { error: appointmentError } : {}),
          }),
        },
      });
      return { event, action };
    }

    const systemUser = this.createSystemUser(config.organizationId);
    const timeoutMs = this.configService.get<number>(
      'VOICE_AI_TIMEOUT_MS',
      8000,
    );
    let searchResults: Awaited<ReturnType<KnowledgeService['search']>> = [];
    let chatResult: Awaited<ReturnType<ChatService['answerWithContext']>>;
    try {
      searchResults = await this.withTimeout(
        this.knowledgeService.search(systemUser, {
          query: content,
          limit: 5,
          productKey: 'voice_receptionist',
        }),
        timeoutMs,
      );
      chatResult = await this.withTimeout(
        this.chatService.answerWithContext({
          organizationId: config.organizationId,
          question: this.buildConversationQuestion(call, content),
          safeFallback: true,
          context: searchResults.map((result) => ({
            content: result.content,
            score: result.score,
          })),
        }),
        timeoutMs,
      );
    } catch (error) {
      chatResult = {
        answer: this.getSettingString(
          config,
          'errorMessage',
          'I am sorry, I am having trouble answering right now. Please try again or ask for a person.',
        ),
        model: 'fallback',
        provider: 'local',
        adapter: 'guardrail',
        usedFallback: true,
        error: error instanceof Error ? error.message : 'Voice AI failed',
      };
    }

    const action = await this.deliverAssistantReply(
      config,
      call,
      chatResult.answer,
      delivery,
    );
    const event = await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'assistant_response',
        role: 'assistant',
        content: chatResult.answer,
        metadata: this.toJsonObject({
          model: chatResult.model,
          provider: chatResult.provider,
          adapter: chatResult.adapter,
          usedFallback: chatResult.usedFallback,
          error: chatResult.error,
          action,
          citations: searchResults.map((result) => ({
            chunkId: result.id,
            score: result.score,
          })),
        }),
      },
    });

    return { event, action };
  }

  private readAppointmentAction(
    metadata?: Record<string, unknown>,
  ): AppointmentActionDto | undefined {
    const value = metadata?.appointmentAction;
    return value && !Array.isArray(value) && typeof value === 'object'
      ? (value as AppointmentActionDto)
      : undefined;
  }

  private async deliverAssistantReply(
    config: VoiceReceptionistConfig,
    call: VoiceCallWithEvents,
    content: string,
    delivery: 'provider' | 'inline',
  ): Promise<VoiceProviderActionResult> {
    if (delivery === 'inline') {
      return {
        provider: 'twilio',
        status: 'sent',
        providerActionId: `twiml-${call.providerCallId ?? call.id}`,
      };
    }
    return this.safeProviderAction(config.provider, () =>
      this.outboundService.speakText({
        config,
        providerCallId: call.providerCallId,
        content,
      }),
    );
  }

  private async storeTwilioResponse(
    event: Prisma.VoiceCallEventGetPayload<object>,
    responseTwiml: string,
  ): Promise<void> {
    await this.prisma.voiceCallEvent.update({
      where: { id: event.id },
      data: {
        metadata: this.toJsonObject({
          ...this.toRecord(event.metadata),
          responseTwiml,
        }),
      },
    });
  }

  private buildConversationQuestion(
    call: VoiceCallWithEvents,
    currentMessage: string,
  ): string {
    const history = call.events
      .filter(
        (event) =>
          event.content &&
          ['caller', 'assistant', 'agent'].includes(event.role) &&
          ['transcript', 'assistant_response'].includes(event.type),
      )
      .slice(-10)
      .map((event) => {
        const speaker = event.role === 'caller' ? 'Caller' : 'Receptionist';
        return `${speaker}: ${event.content}`;
      })
      .join('\n')
      .slice(-3500);
    return history
      ? `Use the conversation history to resolve follow-up references.\n${history}\nCaller: ${currentMessage}`
      : currentMessage;
  }

  private async createHandoffSummary(
    config: VoiceReceptionistConfig,
    call: VoiceCallWithEvents,
  ): Promise<string> {
    const transcript = call.events
      .filter(
        (event) =>
          event.content &&
          ['caller', 'assistant', 'agent'].includes(event.role),
      )
      .slice(-12)
      .map((event) => `${event.role}: ${event.content}`)
      .join('\n');
    const fallback = transcript
      ? transcript.slice(0, 700)
      : 'The caller requested a human before providing additional details.';
    try {
      const result = await this.withTimeout(
        this.chatService.answerWithContext({
          organizationId: config.organizationId,
          question:
            'Summarize this caller handoff for a human agent in at most 80 words. Include intent, important details, actions already attempted, and what remains unresolved. Do not invent facts.',
          safeFallback: true,
          context: transcript ? [{ content: transcript, score: 1 }] : [],
        }),
        Math.min(
          this.configService.get<number>('VOICE_AI_TIMEOUT_MS', 8000),
          5000,
        ),
      );
      return result.usedFallback ? fallback : result.answer.slice(0, 1000);
    } catch {
      return fallback;
    }
  }

  private isHumanHandoffRequest(content: string): boolean {
    const normalized = content.toLowerCase();
    return (
      /\b(speak|talk|connect|transfer|route|need|want)\b.{0,40}\b(human|person|agent|representative|operator|staff)\b/.test(
        normalized,
      ) ||
      /\b(human|live agent|representative|operator)\b.{0,25}\b(please|now|instead)\b/.test(
        normalized,
      )
    );
  }

  private async prepareBrowserHandoff(
    config: VoiceReceptionistConfig,
    callId: string,
  ): Promise<{ clientIdentity: string; userId: string } | null> {
    if (!this.softphoneService) return null;
    const call = await this.prisma.voiceCall.findUnique({
      where: { id: callId },
      include: this.callInclude(),
    });
    if (!call) return null;
    const agent = await this.softphoneService.findAvailableAgent(
      config.organizationId,
      call.assignedAgentId,
    );
    if (!agent) return null;
    const summary = await this.createHandoffSummary(config, call);
    await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: 'transferred',
        assignedAgentId: agent.userId,
        summary,
        lastEventAt: new Date(),
      },
    });
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId: config.organizationId,
        callId: call.id,
        type: 'transfer_requested',
        role: 'system',
        content: `Caller requested a human; routing to ${agent.user.name}.`,
        metadata: this.toJsonObject({
          transport: 'browser',
          assignedAgentId: agent.userId,
          summary,
        }),
      },
    });
    this.publishCallUpdate(call);
    return {
      clientIdentity: agent.clientIdentity,
      userId: agent.userId,
    };
  }

  private async loadSignedTwilioConfig(
    configId: string,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertVoiceEnabled(config.organizationId);
    this.assertTwilioCallbackSignature(config, rawBody, headers, requestUrl);
    return config;
  }

  private assertTwilioCallbackSignature(
    config: VoiceReceptionistConfig,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ): void {
    const required = this.configService.get<boolean>(
      'VOICE_WEBHOOK_SIGNATURE_REQUIRED',
      true,
    );
    const signature = this.getHeader(headers, 'x-twilio-signature');
    if (!required && !signature) return;
    if (!signature || !rawBody || !config.apiKeyEncrypted) {
      throw new ForbiddenException('Invalid Twilio webhook signature');
    }
    const params = [...new URLSearchParams(rawBody.toString('utf8')).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}${value}`)
      .join('');
    const expected = createHmac(
      'sha1',
      this.cryptoService.decrypt(config.apiKeyEncrypted),
    )
      .update(`${this.buildWebhookUrl(requestUrl)}${params}`)
      .digest('base64');
    if (!this.secureCompareText(expected, signature)) {
      throw new ForbiddenException('Invalid Twilio webhook signature');
    }
  }

  private async findCallByProvider(configId: string, providerCallId: string) {
    const call = await this.prisma.voiceCall.findUnique({
      where: { configId_providerCallId: { configId, providerCallId } },
      include: this.callInclude(),
    });
    if (!call) throw new NotFoundException('Voice call not found');
    return call;
  }

  private async findOrCreateCallbackCall(
    config: VoiceReceptionistConfig,
    providerCallId: string,
  ) {
    return this.prisma.voiceCall.upsert({
      where: {
        configId_providerCallId: { configId: config.id, providerCallId },
      },
      create: {
        organizationId: config.organizationId,
        configId: config.id,
        providerCallId,
        locale: config.defaultLocale,
        status: 'ringing',
      },
      update: {},
      include: this.callInclude(),
    });
  }

  private mapTwilioCallStatus(status: string): VoiceCallWithEvents['status'] {
    if (status === 'completed') return 'completed';
    if (['busy', 'canceled', 'failed', 'no-answer'].includes(status)) {
      return 'failed';
    }
    if (['answered', 'in-progress'].includes(status)) return 'in_progress';
    return 'ringing';
  }

  private parseOptionalInt(value?: string): number | undefined {
    if (value === undefined || !/^\d+$/.test(value)) return undefined;
    return Number(value);
  }

  private parseOptionalFloat(value?: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseConversationRelayHandoff(value?: string):
    | {
        action?: 'transfer' | 'voicemail' | 'close' | 'client';
        transferTo?: string;
        clientIdentity?: string;
        callId?: string;
      }
    | undefined {
    if (!value || value.length > 2_000) return undefined;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const action = ['transfer', 'voicemail', 'close', 'client'].includes(
        String(parsed.action),
      )
        ? (parsed.action as 'transfer' | 'voicemail' | 'close' | 'client')
        : undefined;
      const transferTo =
        typeof parsed.transferTo === 'string' &&
        /^\+[1-9]\d{7,14}$/.test(parsed.transferTo)
          ? parsed.transferTo
          : undefined;
      const clientIdentity =
        typeof parsed.clientIdentity === 'string' &&
        /^[a-zA-Z0-9_]{1,121}$/.test(parsed.clientIdentity)
          ? parsed.clientIdentity
          : undefined;
      const callId =
        typeof parsed.callId === 'string' && parsed.callId.length <= 100
          ? parsed.callId
          : undefined;
      return { action, transferTo, clientIdentity, callId };
    } catch {
      return undefined;
    }
  }

  private async upsertCall(
    config: VoiceReceptionistConfig,
    input: VoiceWebhookEventDto,
    now: Date,
  ): Promise<VoiceCallWithEvents> {
    const providerCallId = input.providerCallId;
    const existing = await this.prisma.voiceCall.findUnique({
      where: {
        configId_providerCallId: { configId: config.id, providerCallId },
      },
      include: this.callInclude(),
    });
    if (existing) {
      const terminal = [
        'completed',
        'failed',
        'transferred',
        'voicemail',
      ].includes(existing.status);
      return this.prisma.voiceCall.update({
        where: { id: existing.id },
        data: {
          fromNumber: input.fromNumber,
          toNumber: input.toNumber,
          callerName: input.callerName,
          locale: input.locale ?? undefined,
          status:
            input.eventType === VoiceCallEventTypeDto.call_started && !terminal
              ? 'in_progress'
              : undefined,
          lastEventAt: now,
        },
        include: this.callInclude(),
      });
    }

    return this.prisma.voiceCall.upsert({
      where: {
        configId_providerCallId: { configId: config.id, providerCallId },
      },
      create: {
        organizationId: config.organizationId,
        configId: config.id,
        providerCallId,
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        callerName: input.callerName,
        locale: input.locale ?? config.defaultLocale,
        status:
          input.eventType === VoiceCallEventTypeDto.call_started
            ? 'in_progress'
            : 'ringing',
        lastEventAt: now,
        metadata: this.toJsonObject(input.metadata),
      },
      update: {
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        callerName: input.callerName,
        locale: input.locale ?? undefined,
        lastEventAt: now,
      },
      include: this.callInclude(),
    });
  }

  private async recordRouteDecision(
    callId: string,
    organizationId: string,
    content: string,
    action: VoiceProviderActionResult | { provider: 'mock'; status: string },
  ) {
    await this.prisma.voiceCallEvent.create({
      data: {
        organizationId,
        callId,
        type: 'route_decision',
        role: 'system',
        content,
        metadata: this.toJsonObject({ action }),
      },
    });
  }

  private async findConfigForActor(currentUser: AuthenticatedUser, id: string) {
    const config = await this.prisma.voiceReceptionistConfig.findUnique({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('Voice config not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      config.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Voice config not found');
    }

    await this.assertVoiceEnabled(config.organizationId);

    return config;
  }

  private assertWebhookSignature(
    config: VoiceReceptionistConfig,
    input: VoiceWebhookEventDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    requestUrl?: { protocol?: string; host?: string; originalUrl?: string },
  ) {
    const signatureRequired = this.configService.get<boolean>(
      'VOICE_WEBHOOK_SIGNATURE_REQUIRED',
      true,
    );
    const twilioSignature = this.getHeader(headers, 'x-twilio-signature');
    const agentCoreSignature = this.getHeader(headers, 'x-agentcore-signature');

    if (!signatureRequired && !twilioSignature && !agentCoreSignature) {
      return;
    }

    if (!config.apiKeyEncrypted) {
      throw new ForbiddenException(
        'Voice webhook signing secret is not configured',
      );
    }

    if (!rawBody || (!twilioSignature && !agentCoreSignature)) {
      throw new ForbiddenException('Invalid voice webhook signature');
    }

    const secret = this.cryptoService.decrypt(config.apiKeyEncrypted);
    if (twilioSignature) {
      const url = this.buildWebhookUrl(requestUrl);
      const params = Object.entries(input)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}${this.signatureValue(value)}`)
        .join('');
      const expected = createHmac('sha1', secret)
        .update(`${url}${params}`)
        .digest('base64');
      if (!this.secureCompareText(expected, twilioSignature)) {
        throw new ForbiddenException('Invalid Twilio webhook signature');
      }
      return;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const normalized = agentCoreSignature!.startsWith('sha256=')
      ? agentCoreSignature!.slice('sha256='.length)
      : agentCoreSignature!;

    if (!this.secureCompare(expected, normalized)) {
      throw new ForbiddenException('Invalid voice webhook signature');
    }
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
    name: string,
  ): string | undefined {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];

    return Array.isArray(value) ? value[0] : value;
  }

  private secureCompare(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');

    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  private secureCompareText(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  private buildWebhookUrl(request?: {
    protocol?: string;
    host?: string;
    originalUrl?: string;
  }): string {
    const configuredBase = this.configService
      .get<string>('VOICE_WEBHOOK_PUBLIC_BASE_URL')
      ?.replace(/\/$/, '');
    const path = request?.originalUrl ?? '';
    if (configuredBase) return `${configuredBase}${path}`;
    if (request?.protocol && request.host) {
      return `${request.protocol}://${request.host}${path}`;
    }
    throw new ForbiddenException('Cannot determine signed webhook URL');
  }

  private signatureValue(value: unknown): string {
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value.toString();
    }
    return '';
  }

  private async findActiveConfig(id: string) {
    const config = await this.prisma.voiceReceptionistConfig.findFirst({
      where: { id, status: 'active' },
    });

    if (!config) {
      throw new NotFoundException('Voice config not found');
    }

    return config;
  }

  private async findCallForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<VoiceCallWithEvents> {
    const call = await this.prisma.voiceCall.findUnique({
      where: { id },
      include: this.callInclude(),
    });

    if (!call) {
      throw new NotFoundException('Voice call not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      call.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Voice call not found');
    }

    await this.assertVoiceEnabled(call.organizationId);

    return call;
  }

  private async assertVoiceEnabled(organizationId: string) {
    const entitlement = await this.prisma.organizationProduct.findFirst({
      where: {
        organizationId,
        status: 'enabled',
        product: { key: 'voice_receptionist', status: 'active' },
      },
    });

    if (!entitlement) {
      throw new ForbiddenException('Voice Receptionist is not enabled');
    }
  }

  private async assertAssignableAgent(
    organizationId: string,
    assignedAgentId: string,
  ) {
    const agent = await this.prisma.user.findUnique({
      where: { id: assignedAgentId },
      select: {
        orgId: true,
        roles: true,
        isActive: true,
      },
    });

    const canHandleCall =
      agent?.isActive &&
      agent.orgId === organizationId &&
      (agent.roles.includes('agent') || agent.roles.includes('org_admin'));

    if (!canHandleCall) {
      throw new ForbiddenException('Assigned agent cannot handle this call');
    }
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ): string {
    if (!organizationId) {
      return currentUser.orgId;
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      organizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException('Cannot manage another organization');
    }

    return organizationId;
  }

  private evaluateBusinessHours(config: VoiceReceptionistConfig): {
    isOpen: boolean;
  } {
    const settings = this.toRecord(config.settings);
    const businessHours = settings.businessHours;
    if (
      !businessHours ||
      typeof businessHours !== 'object' ||
      Array.isArray(businessHours)
    ) {
      return { isOpen: true };
    }

    const rule = businessHours as Record<string, unknown>;
    if (rule.enabled === false) {
      return { isOpen: true };
    }

    const now = new Date();
    const days = Array.isArray(rule.days) ? rule.days : [1, 2, 3, 4, 5];
    const startTime =
      typeof rule.startTime === 'string' ? rule.startTime : '09:00';
    const endTime = typeof rule.endTime === 'string' ? rule.endTime : '18:00';
    const timezone = typeof rule.timezone === 'string' ? rule.timezone : 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const day = weekdayMap[part('weekday')];
    const current = `${part('hour')}:${part('minute')}`;
    const localDate = `${part('year')}-${part('month')}-${part('day')}`;
    const holidays = Array.isArray(rule.holidays) ? rule.holidays : [];

    if (holidays.includes(localDate)) {
      return { isOpen: false };
    }

    const isOvernight = startTime > endTime;
    const previousDay = (day + 6) % 7;
    const dayIsOpen = isOvernight
      ? (days.includes(day) && current >= startTime) ||
        (days.includes(previousDay) && current < endTime)
      : days.includes(day) && current >= startTime && current < endTime;

    return { isOpen: dayIsOpen };
  }

  private validateSettings(settings?: Record<string, unknown>): void {
    if (!settings) return;

    const hours = settings.businessHours;
    if (hours !== undefined) {
      if (!hours || typeof hours !== 'object' || Array.isArray(hours)) {
        throw new BadRequestException(
          'settings.businessHours must be an object',
        );
      }
      const rule = hours as Record<string, unknown>;
      if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
        throw new BadRequestException(
          'settings.businessHours.enabled must be a boolean',
        );
      }
      const timezone =
        typeof rule.timezone === 'string' ? rule.timezone : 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
      } catch {
        throw new BadRequestException(
          'settings.businessHours.timezone must be a valid IANA timezone',
        );
      }
      const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      for (const field of ['startTime', 'endTime'] as const) {
        const value = rule[field];
        if (
          value !== undefined &&
          (typeof value !== 'string' || !timePattern.test(value))
        ) {
          throw new BadRequestException(
            `settings.businessHours.${field} must use HH:mm`,
          );
        }
      }
      if (
        rule.days !== undefined &&
        (!Array.isArray(rule.days) ||
          rule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      ) {
        throw new BadRequestException(
          'settings.businessHours.days must contain integers from 0 to 6',
        );
      }
      if (
        rule.holidays !== undefined &&
        (!Array.isArray(rule.holidays) ||
          rule.holidays.some(
            (date) =>
              typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date),
          ))
      ) {
        throw new BadRequestException(
          'settings.businessHours.holidays must contain YYYY-MM-DD dates',
        );
      }
    }

    const routes = settings.routingKeywords;
    if (routes !== undefined) {
      if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
        throw new BadRequestException(
          'settings.routingKeywords must be an object',
        );
      }
      for (const target of Object.values(routes)) {
        if (typeof target !== 'string' || !/^\+[1-9]\d{7,14}$/.test(target)) {
          throw new BadRequestException(
            'Every routing keyword target must be an E.164 phone number',
          );
        }
      }
    }

    for (const key of [
      'twilioGatherUrl',
      'twilioDialCallbackUrl',
      'twilioRecordingCallbackUrl',
      'twilioConversationRelayCallbackUrl',
      'twilioClientStatusCallbackUrl',
    ]) {
      const value = settings[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' || !this.isHttpsUrl(value))
      ) {
        throw new BadRequestException(`settings.${key} must be an HTTPS URL`);
      }
    }

    const relayUrl = settings.conversationRelayUrl;
    if (
      relayUrl !== undefined &&
      (typeof relayUrl !== 'string' || !/^wss:\/\//.test(relayUrl))
    ) {
      throw new BadRequestException(
        'settings.conversationRelayUrl must be a WSS URL',
      );
    }
    const relayTtsProvider = settings.conversationRelayTtsProvider;
    if (
      relayTtsProvider !== undefined &&
      (typeof relayTtsProvider !== 'string' ||
        !['Amazon', 'Google', 'ElevenLabs'].includes(relayTtsProvider))
    ) {
      throw new BadRequestException(
        'settings.conversationRelayTtsProvider is unsupported',
      );
    }
    const relaySttProvider = settings.conversationRelayTranscriptionProvider;
    if (
      relaySttProvider !== undefined &&
      (typeof relaySttProvider !== 'string' ||
        !['Deepgram', 'Google'].includes(relaySttProvider))
    ) {
      throw new BadRequestException(
        'settings.conversationRelayTranscriptionProvider is unsupported',
      );
    }

    const dtmfRoutes = settings.dtmfRoutes;
    if (
      dtmfRoutes !== undefined &&
      (!dtmfRoutes ||
        typeof dtmfRoutes !== 'object' ||
        Array.isArray(dtmfRoutes))
    ) {
      throw new BadRequestException('settings.dtmfRoutes must be an object');
    }
    if (
      dtmfRoutes &&
      typeof dtmfRoutes === 'object' &&
      !Array.isArray(dtmfRoutes)
    ) {
      for (const [digits, route] of Object.entries(dtmfRoutes)) {
        const target =
          typeof route === 'string'
            ? route
            : route && typeof route === 'object' && !Array.isArray(route)
              ? (route as Record<string, unknown>).transferTo
              : undefined;
        if (
          !/^\d+$/.test(digits) ||
          typeof target !== 'string' ||
          !/^\+[1-9]\d{7,14}$/.test(target)
        ) {
          throw new BadRequestException(
            'Every DTMF route must map digits to an E.164 phone number',
          );
        }
      }
    }

    const voicemailMaxLength = settings.voicemailMaxLengthSeconds;
    if (
      voicemailMaxLength !== undefined &&
      (typeof voicemailMaxLength !== 'number' ||
        !Number.isInteger(voicemailMaxLength) ||
        voicemailMaxLength < 10 ||
        voicemailMaxLength > 600)
    ) {
      throw new BadRequestException(
        'settings.voicemailMaxLengthSeconds must be an integer from 10 to 600',
      );
    }
    for (const key of [
      'handoffNotificationEmail',
      'voicemailNotificationEmail',
    ]) {
      const value = settings[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      ) {
        throw new BadRequestException(
          `settings.${key} must be an email address`,
        );
      }
    }
    for (const key of [
      'handoffNotificationPhone',
      'voicemailNotificationPhone',
    ]) {
      const value = settings[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value))
      ) {
        throw new BadRequestException(
          `settings.${key} must be an E.164 phone number`,
        );
      }
    }
  }

  private isHttpsUrl(value: string): boolean {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private matchKeywordRoute(
    config: VoiceReceptionistConfig,
    content: string,
  ): { department: string; transferTo: string } | undefined {
    const routes = this.toRecord(config.settings).routingKeywords;
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
      return undefined;
    }
    const normalized = content.toLocaleLowerCase(config.defaultLocale);
    for (const [department, transferTo] of Object.entries(routes)) {
      if (
        typeof transferTo === 'string' &&
        normalized.includes(department.toLocaleLowerCase(config.defaultLocale))
      ) {
        return { department, transferTo };
      }
    }
    return undefined;
  }

  private matchDtmfRoute(
    config: VoiceReceptionistConfig,
    digits: string,
  ): { department: string; transferTo: string } | undefined {
    const routes = this.toRecord(config.settings).dtmfRoutes;
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
      return undefined;
    }
    const route = (routes as Record<string, unknown>)[digits];
    if (typeof route === 'string') {
      return { department: `menu option ${digits}`, transferTo: route };
    }
    if (route && typeof route === 'object' && !Array.isArray(route)) {
      const value = route as Record<string, unknown>;
      if (typeof value.transferTo === 'string') {
        return {
          department:
            typeof value.department === 'string'
              ? value.department
              : `menu option ${digits}`,
          transferTo: value.transferTo,
        };
      }
    }
    return undefined;
  }

  private getSettingString(
    config: VoiceReceptionistConfig,
    key: string,
    fallback: string,
  ): string {
    const value = this.toRecord(config.settings)[key];
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  private async safeProviderAction(
    provider: VoiceReceptionistConfig['provider'],
    action: () => Promise<VoiceProviderActionResult>,
  ): Promise<VoiceProviderActionResult> {
    try {
      return await action();
    } catch (error) {
      return {
        provider,
        status: 'failed',
        providerActionId: `failed-${Date.now()}`,
        error:
          error instanceof Error
            ? error.message
            : 'Voice provider action failed',
      };
    }
  }

  private publishCallUpdate(call: {
    id: string;
    organizationId: string;
    providerCallId?: string | null;
  }): void {
    this.runtimeService?.publish({
      type: 'call.updated',
      organizationId: call.organizationId,
      callId: call.id,
      providerCallId: call.providerCallId ?? undefined,
    });
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Voice AI timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private roleForEvent(type: string): string {
    if (['stt_partial', 'transcript', 'barge_in'].includes(type)) {
      return 'caller';
    }

    return 'system';
  }

  private callInclude() {
    return {
      events: {
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }

  private toConfigResponse(config: VoiceReceptionistConfig) {
    return {
      id: config.id,
      organizationId: config.organizationId,
      provider: config.provider,
      status: config.status,
      name: config.name,
      phoneNumber: config.phoneNumber,
      sipDomain: config.sipDomain,
      hasWebhookVerifyToken: Boolean(config.webhookVerifyTokenEncrypted),
      hasApiKey: Boolean(config.apiKeyEncrypted),
      sttProvider: config.sttProvider,
      sttModel: config.sttModel,
      ttsProvider: config.ttsProvider,
      ttsVoice: config.ttsVoice,
      defaultLocale: config.defaultLocale,
      transferPhoneNumber: config.transferPhoneNumber,
      voicemailEnabled: config.voicemailEnabled,
      settings: this.toRecord(config.settings),
    };
  }

  private toCallResponse(call: VoiceCallWithEvents) {
    return {
      ...call,
      metadata: this.toRecord(call.metadata),
      events: call.events.map((event) => this.toEventResponse(event)),
    };
  }

  private toEventResponse(event: VoiceCallWithEvents['events'][number]) {
    return {
      ...event,
      metadata: this.toRecord(event.metadata),
    };
  }

  private createSystemUser(organizationId: string): AuthenticatedUser {
    return {
      sub: 'voice-receptionist',
      email: 'voice-receptionist@agentcore.local',
      orgId: organizationId,
      roles: ['user'],
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
