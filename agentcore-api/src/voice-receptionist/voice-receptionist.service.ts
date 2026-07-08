import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Prisma, VoiceReceptionistConfig } from '@prisma/client';
import { ChatService } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignVoiceCallDto,
  CreateVoiceConfigDto,
  ListVoiceCallsDto,
  RouteVoiceCallDto,
  SendVoiceAgentMessageDto,
  UpdateVoiceCallStatusDto,
  UpdateVoiceConfigDto,
  VoiceCallEventTypeDto,
  VoiceRouteActionDto,
  VoiceWebhookEventDto,
} from './dto/voice-receptionist.dto';
import {
  VoiceOutboundService,
  VoiceProviderActionResult,
} from './voice-outbound.service';

type VoiceCallWithEvents = Prisma.VoiceCallGetPayload<{
  include: {
    events: true;
  };
}>;

@Injectable()
export class VoiceReceptionistService {
  constructor(
    private readonly auditService: AuditService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly knowledgeService: KnowledgeService,
    private readonly outboundService: VoiceOutboundService,
    private readonly prisma: PrismaService,
  ) {}

  async listConfigs(currentUser: AuthenticatedUser) {
    const configs = await this.prisma.voiceReceptionistConfig.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { organizationId: currentUser.orgId },
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

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendVoiceAgentMessageDto,
  ) {
    const call = await this.findCallForActor(currentUser, id);
    const config = await this.prisma.voiceReceptionistConfig.findUniqueOrThrow({
      where: { id: call.configId },
    });
    const action = this.outboundService.speakText({
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

    return this.toCallResponse(updated);
  }

  async requestHandoff(currentUser: AuthenticatedUser, id: string) {
    const call = await this.findCallForActor(currentUser, id);

    const updated = await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        status: 'waiting_for_agent',
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
        content: 'Human handoff requested',
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: call.organizationId,
      action: 'voice.handoff_requested',
      entityType: 'voice_call',
      entityId: call.id,
    });

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
      action = this.outboundService.transferCall({
        config,
        providerCallId: call.providerCallId,
        transferTo: input.transferTo ?? config.transferPhoneNumber,
      });
      status = 'transferred';
    } else if (input.action === VoiceRouteActionDto.voicemail) {
      action = this.outboundService.sendToVoicemail({
        config,
        providerCallId: call.providerCallId,
      });
      status = 'voicemail';
    } else {
      action = this.outboundService.speakText({
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

    if (
      config.webhookVerifyTokenEncrypted &&
      verifyToken !==
        this.cryptoService.decrypt(config.webhookVerifyTokenEncrypted)
    ) {
      throw new ForbiddenException('Invalid voice webhook verify token');
    }

    return challenge ?? 'ok';
  }

  async handleWebhookEvent(
    configId: string,
    input: VoiceWebhookEventDto,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertVoiceEnabled(config.organizationId);
    this.assertWebhookSignature(config, rawBody, headers);

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
      if (!routing.isOpen && config.voicemailEnabled) {
        action = this.outboundService.sendToVoicemail({
          config,
          providerCallId: call.providerCallId,
        });
        await this.recordRouteDecision(
          call.id,
          config.organizationId,
          'Outside business hours. Sending to voicemail.',
          action,
        );
        await this.prisma.voiceCall.update({
          where: { id: call.id },
          data: { status: 'voicemail', lastEventAt: new Date() },
        });
      }
    }

    if (
      input.eventType === VoiceCallEventTypeDto.transcript &&
      input.content &&
      call.status !== 'waiting_for_agent'
    ) {
      const assistantReply = await this.createAssistantReply(
        config,
        call,
        input.content,
      );
      assistantEvent = assistantReply.event;
      action = assistantReply.action;
    }

    if (input.eventType === VoiceCallEventTypeDto.barge_in) {
      await this.prisma.voiceCallEvent.create({
        data: {
          organizationId: config.organizationId,
          callId: call.id,
          type: 'route_decision',
          role: 'system',
          content: 'Caller interrupted active TTS playback.',
          metadata: this.toJsonObject({ interrupt: true }),
        },
      });
    }

    if (input.eventType === VoiceCallEventTypeDto.call_ended) {
      await this.prisma.voiceCall.update({
        where: { id: call.id },
        data: {
          status: 'completed',
          endedAt: now,
          lastEventAt: now,
          summary: input.content,
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

  private async createAssistantReply(
    config: VoiceReceptionistConfig,
    call: VoiceCallWithEvents,
    content: string,
  ): Promise<{
    event: Prisma.VoiceCallEventGetPayload<object>;
    action: VoiceProviderActionResult;
  }> {
    const systemUser = this.createSystemUser(config.organizationId);
    const searchResults = await this.knowledgeService.search(systemUser, {
      query: content,
      limit: 5,
    });
    const chatResult = await this.chatService.answerWithContext({
      organizationId: config.organizationId,
      question: content,
      context: searchResults.map((result) => ({
        content: result.content,
        score: result.score,
      })),
    });

    const action = this.outboundService.speakText({
      config,
      providerCallId: call.providerCallId,
      content: chatResult.answer,
    });
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

  private async upsertCall(
    config: VoiceReceptionistConfig,
    input: VoiceWebhookEventDto,
    now: Date,
  ): Promise<VoiceCallWithEvents> {
    const providerCallId =
      input.providerCallId ?? `local-${config.id}-${now.getTime()}`;

    return this.prisma.voiceCall.upsert({
      where: {
        configId_providerCallId: {
          configId: config.id,
          providerCallId,
        },
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
        status:
          input.eventType === VoiceCallEventTypeDto.call_started
            ? 'in_progress'
            : undefined,
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
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    const signatureRequired = this.configService.get<boolean>(
      'VOICE_WEBHOOK_SIGNATURE_REQUIRED',
      false,
    );
    const signature = this.getHeader(headers, 'x-agentcore-signature');

    if (!signatureRequired && !signature) {
      return;
    }

    if (!config.apiKeyEncrypted) {
      throw new ForbiddenException(
        'Voice webhook signing secret is not configured',
      );
    }

    if (!rawBody || !signature) {
      throw new ForbiddenException('Invalid voice webhook signature');
    }

    const secret = this.cryptoService.decrypt(config.apiKeyEncrypted);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const normalized = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;

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
    const day = now.getUTCDay();
    const current = `${String(now.getUTCHours()).padStart(2, '0')}:${String(
      now.getUTCMinutes(),
    ).padStart(2, '0')}`;

    return {
      isOpen: days.includes(day) && current >= startTime && current <= endTime,
    };
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
