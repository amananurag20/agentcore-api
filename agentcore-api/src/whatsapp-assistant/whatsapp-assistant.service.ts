import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WhatsAppAssistantConfig } from '@prisma/client';
import { ChatService } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignWhatsAppConversationDto,
  CreateWhatsAppConfigDto,
  ListWhatsAppConversationsDto,
  SendWhatsAppAgentMessageDto,
  UpdateWhatsAppConfigDto,
  UpdateWhatsAppConversationStatusDto,
  WhatsAppInboundWebhookDto,
} from './dto/whatsapp-assistant.dto';
import {
  WhatsAppOutboundResult,
  WhatsAppOutboundService,
} from './whatsapp-outbound.service';

type WhatsAppConversationWithMessages = Prisma.WhatsAppConversationGetPayload<{
  include: {
    messages: true;
  };
}>;

@Injectable()
export class WhatsAppAssistantService {
  constructor(
    private readonly auditService: AuditService,
    private readonly chatService: ChatService,
    private readonly cryptoService: CryptoService,
    private readonly knowledgeService: KnowledgeService,
    private readonly outboundService: WhatsAppOutboundService,
    private readonly prisma: PrismaService,
  ) {}

  async listConfigs(currentUser: AuthenticatedUser) {
    const configs = await this.prisma.whatsAppAssistantConfig.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { organizationId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
    });

    return configs.map((config) => this.toConfigResponse(config));
  }

  async createConfig(
    currentUser: AuthenticatedUser,
    input: CreateWhatsAppConfigDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertWhatsAppEnabled(organizationId);

    const config = await this.prisma.whatsAppAssistantConfig.create({
      data: {
        organizationId,
        provider: input.provider ?? 'meta',
        status: input.status ?? 'active',
        name: input.name,
        phoneNumberId: input.phoneNumberId,
        businessAccountId: input.businessAccountId,
        accessTokenEncrypted: input.accessToken
          ? this.cryptoService.encrypt(input.accessToken)
          : undefined,
        webhookVerifyTokenEncrypted: input.webhookVerifyToken
          ? this.cryptoService.encrypt(input.webhookVerifyToken)
          : undefined,
        appSecretEncrypted: input.appSecret
          ? this.cryptoService.encrypt(input.appSecret)
          : undefined,
        defaultLocale: input.defaultLocale ?? 'en',
        settings: this.toJsonObject(input.settings),
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'whatsapp.config_created',
      entityType: 'whatsapp_config',
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
    input: UpdateWhatsAppConfigDto,
  ) {
    const existing = await this.findConfigForActor(currentUser, id);

    const config = await this.prisma.whatsAppAssistantConfig.update({
      where: { id: existing.id },
      data: {
        provider: input.provider,
        status: input.status,
        name: input.name,
        phoneNumberId: input.phoneNumberId,
        businessAccountId: input.businessAccountId,
        accessTokenEncrypted:
          input.accessToken === undefined
            ? undefined
            : input.accessToken
              ? this.cryptoService.encrypt(input.accessToken)
              : null,
        webhookVerifyTokenEncrypted:
          input.webhookVerifyToken === undefined
            ? undefined
            : input.webhookVerifyToken
              ? this.cryptoService.encrypt(input.webhookVerifyToken)
              : null,
        appSecretEncrypted:
          input.appSecret === undefined
            ? undefined
            : input.appSecret
              ? this.cryptoService.encrypt(input.appSecret)
              : null,
        defaultLocale: input.defaultLocale,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.config_updated',
      entityType: 'whatsapp_config',
      entityId: config.id,
    });

    return this.toConfigResponse(config);
  }

  async listConversations(
    currentUser: AuthenticatedUser,
    input: ListWhatsAppConversationsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertWhatsAppEnabled(organizationId);

    const where: Prisma.WhatsAppConversationWhereInput = {
      organizationId,
      status: input.status,
    };

    if (input.search) {
      where.OR = [
        { contactWaId: { contains: input.search, mode: 'insensitive' } },
        { contactName: { contains: input.search, mode: 'insensitive' } },
        { contactPhone: { contains: input.search, mode: 'insensitive' } },
      ];
    }

    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const [total, conversations] = await this.prisma.$transaction([
      this.prisma.whatsAppConversation.count({ where }),
      this.prisma.whatsAppConversation.findMany({
        where,
        include: this.conversationInclude(),
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: conversations.map((conversation) =>
        this.toConversationResponse(conversation),
      ),
      total,
      page,
      limit,
    };
  }

  async getConversation(currentUser: AuthenticatedUser, id: string) {
    const conversation = await this.findConversationForActor(currentUser, id);
    return this.toConversationResponse(conversation);
  }

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendWhatsAppAgentMessageDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.assertWhatsAppEnabled(conversation.organizationId);

    const config = await this.prisma.whatsAppAssistantConfig.findUniqueOrThrow({
      where: { id: conversation.configId },
    });
    const delivery = await this.outboundService.sendText({
      config,
      to: conversation.contactWaId,
      content: input.content,
    });
    const message = await this.prisma.whatsAppMessage.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        direction: 'outbound',
        role: 'agent',
        type: 'text',
        providerMessageId: delivery.providerMessageId,
        content: input.content,
        metadata: this.toJsonObject({
          delivery,
          agentId: currentUser.sub,
          agentEmail: currentUser.email,
        }),
      },
    });

    const updated = await this.prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: {
        status: conversation.status === 'closed' ? 'open' : conversation.status,
        assignedAgentId: conversation.assignedAgentId ?? currentUser.sub,
        lastMessageAt: new Date(),
      },
      include: this.conversationInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'whatsapp.agent_replied',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
      metadata: {
        messageId: message.id,
      },
    });

    return {
      conversation: this.toConversationResponse(updated),
      agentMessage: this.toMessageResponse(message),
      delivery,
    };
  }

  async assignConversation(
    currentUser: AuthenticatedUser,
    id: string,
    input: AssignWhatsAppConversationDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    const assignedAgentId = input.assignedAgentId ?? null;

    if (assignedAgentId) {
      await this.assertAssignableAgent(
        conversation.organizationId,
        assignedAgentId,
      );
    }

    const updated = await this.prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { assignedAgentId },
      include: this.conversationInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'whatsapp.conversation_assigned',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
      metadata: { assignedAgentId },
    });

    return this.toConversationResponse(updated);
  }

  async updateConversationStatus(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateWhatsAppConversationStatusDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);

    const updated = await this.prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { status: input.status },
      include: this.conversationInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'whatsapp.status_updated',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
      metadata: { status: input.status },
    });

    return this.toConversationResponse(updated);
  }

  async requestHandoff(currentUser: AuthenticatedUser, id: string) {
    const conversation = await this.findConversationForActor(currentUser, id);

    const updated = await this.prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { status: 'waiting_for_agent' },
      include: this.conversationInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'whatsapp.handoff_requested',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
    });

    return this.toConversationResponse(updated);
  }

  async verifyWebhook(
    configId: string,
    verifyToken?: string,
    challenge?: string,
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertWhatsAppEnabled(config.organizationId);

    if (
      config.webhookVerifyTokenEncrypted &&
      verifyToken !==
        this.cryptoService.decrypt(config.webhookVerifyTokenEncrypted)
    ) {
      throw new ForbiddenException('Invalid WhatsApp webhook verify token');
    }

    return challenge ?? 'ok';
  }

  async handleInboundWebhook(
    configId: string,
    input: WhatsAppInboundWebhookDto,
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertWhatsAppEnabled(config.organizationId);

    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const conversation = await this.prisma.whatsAppConversation.upsert({
      where: {
        configId_contactWaId: {
          configId: config.id,
          contactWaId: input.contactWaId,
        },
      },
      create: {
        organizationId: config.organizationId,
        configId: config.id,
        contactWaId: input.contactWaId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        locale: input.locale ?? config.defaultLocale,
        sessionExpiresAt,
        lastMessageAt: now,
        metadata: this.toJsonObject(input.metadata),
      },
      update: {
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        locale: input.locale ?? undefined,
        sessionExpiresAt,
        lastMessageAt: now,
      },
      include: this.conversationInclude(),
    });

    const inboundMessage = await this.prisma.whatsAppMessage.create({
      data: {
        organizationId: config.organizationId,
        conversationId: conversation.id,
        direction: 'inbound',
        role: 'contact',
        type: input.type ?? 'text',
        providerMessageId: input.providerMessageId,
        content: input.content,
        mediaUrl: input.mediaUrl,
        mediaMimeType: input.mediaMimeType,
        mediaSha256: input.mediaSha256,
        metadata: this.toJsonObject(input.metadata),
      },
    });

    let assistantMessage: Prisma.WhatsAppMessageGetPayload<object> | null =
      null;
    if (conversation.status !== 'waiting_for_agent') {
      const assistantReply = await this.createAssistantReply(
        config,
        config.organizationId,
        conversation.id,
        conversation.contactWaId,
        input.content ?? this.fallbackMediaQuestion(input.type ?? 'unknown'),
      );
      assistantMessage = assistantReply.message;
    }

    const updatedConversation = await this.prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
      include: this.conversationInclude(),
    });

    await this.auditService.record({
      organizationId: config.organizationId,
      action: 'whatsapp.inbound_message_received',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
      metadata: {
        contactWaId: input.contactWaId,
        messageId: inboundMessage.id,
        assistantMessageId: assistantMessage?.id,
      },
    });

    return {
      conversation: this.toConversationResponse(updatedConversation),
      inboundMessage: this.toMessageResponse(inboundMessage),
      assistantMessage: assistantMessage
        ? this.toMessageResponse(assistantMessage)
        : null,
      delivery: {
        provider: assistantMessage ? 'mock' : 'mock',
        status: assistantMessage ? 'queued' : 'handoff_waiting',
      },
    };
  }

  private async createAssistantReply(
    config: WhatsAppAssistantConfig,
    organizationId: string,
    conversationId: string,
    contactWaId: string,
    content: string,
  ): Promise<{
    message: Prisma.WhatsAppMessageGetPayload<object>;
    delivery: WhatsAppOutboundResult;
  }> {
    const systemUser = this.createSystemUser(organizationId);
    const searchResults = await this.knowledgeService.search(systemUser, {
      query: content,
      limit: 5,
    });
    const chatResult = await this.chatService.answerWithContext({
      organizationId,
      question: content,
      context: searchResults.map((result) => ({
        content: result.content,
        score: result.score,
      })),
    });

    const delivery = await this.outboundService.sendText({
      config,
      to: contactWaId,
      content: chatResult.answer,
    });
    const message = await this.prisma.whatsAppMessage.create({
      data: {
        organizationId,
        conversationId,
        direction: 'outbound',
        role: 'assistant',
        type: 'text',
        providerMessageId: delivery.providerMessageId,
        content: chatResult.answer,
        metadata: this.toJsonObject({
          model: chatResult.model,
          provider: chatResult.provider,
          delivery,
          citations: searchResults.map((result) => ({
            chunkId: result.id,
            score: result.score,
          })),
        }),
      },
    });

    return { message, delivery };
  }

  private async findConfigForActor(currentUser: AuthenticatedUser, id: string) {
    const config = await this.prisma.whatsAppAssistantConfig.findUnique({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('WhatsApp config not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      config.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('WhatsApp config not found');
    }

    await this.assertWhatsAppEnabled(config.organizationId);

    return config;
  }

  private async findActiveConfig(id: string) {
    const config = await this.prisma.whatsAppAssistantConfig.findFirst({
      where: { id, status: 'active' },
    });

    if (!config) {
      throw new NotFoundException('WhatsApp config not found');
    }

    return config;
  }

  private async findConversationForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<WhatsAppConversationWithMessages> {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id },
      include: this.conversationInclude(),
    });

    if (!conversation) {
      throw new NotFoundException('WhatsApp conversation not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      conversation.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('WhatsApp conversation not found');
    }

    await this.assertWhatsAppEnabled(conversation.organizationId);

    return conversation;
  }

  private async assertWhatsAppEnabled(organizationId: string) {
    const entitlement = await this.prisma.organizationProduct.findFirst({
      where: {
        organizationId,
        status: 'enabled',
        product: { key: 'whatsapp_assistant', status: 'active' },
      },
    });

    if (!entitlement) {
      throw new ForbiddenException('WhatsApp Assistant is not enabled');
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

    const canHandleConversation =
      agent?.isActive &&
      agent.orgId === organizationId &&
      (agent.roles.includes('agent') || agent.roles.includes('org_admin'));

    if (!canHandleConversation) {
      throw new ForbiddenException(
        'Assigned agent cannot handle this conversation',
      );
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

  private conversationInclude() {
    return {
      messages: {
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }

  private toConfigResponse(config: WhatsAppAssistantConfig) {
    return {
      id: config.id,
      organizationId: config.organizationId,
      provider: config.provider,
      status: config.status,
      name: config.name,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      hasAccessToken: Boolean(config.accessTokenEncrypted),
      hasWebhookVerifyToken: Boolean(config.webhookVerifyTokenEncrypted),
      hasAppSecret: Boolean(config.appSecretEncrypted),
      defaultLocale: config.defaultLocale,
      settings: this.toRecord(config.settings),
    };
  }

  private toConversationResponse(
    conversation: WhatsAppConversationWithMessages,
  ) {
    return {
      ...conversation,
      metadata: this.toRecord(conversation.metadata),
      messages: conversation.messages.map((message) =>
        this.toMessageResponse(message),
      ),
    };
  }

  private toMessageResponse(
    message: WhatsAppConversationWithMessages['messages'][number],
  ) {
    return {
      ...message,
      metadata: this.toRecord(message.metadata),
    };
  }

  private fallbackMediaQuestion(type: string): string {
    return `The customer sent a ${type} message. Respond with a helpful acknowledgement and offer human support if needed.`;
  }

  private createSystemUser(organizationId: string): AuthenticatedUser {
    return {
      sub: 'whatsapp-assistant',
      email: 'whatsapp-assistant@agentcore.local',
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
