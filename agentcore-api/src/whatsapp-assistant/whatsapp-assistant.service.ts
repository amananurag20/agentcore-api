import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WhatsAppAssistantConfig } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChatService } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { AppointmentBookingService } from '../appointment-booking/appointment-booking.service';
import { AppointmentActionDto } from '../appointment-booking/dto/appointment-action.dto';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import {
  AssignWhatsAppConversationDto,
  CreateWhatsAppConfigDto,
  ListWhatsAppConversationsDto,
  SendWhatsAppAgentMessageDto,
  SendWhatsAppMediaMessageDto,
  SendWhatsAppTemplateMessageDto,
  UpdateWhatsAppConfigDto,
  UpdateWhatsAppConversationStatusDto,
  WhatsAppInboundWebhookDto,
} from './dto/whatsapp-assistant.dto';
import {
  WhatsAppOutboundResult,
  WhatsAppOutboundService,
} from './whatsapp-outbound.service';
import { WhatsAppInboundQueueService } from './whatsapp-inbound-queue.service';
import { WhatsAppMediaService } from './whatsapp-media.service';
import {
  isLegacyWebhookPayload,
  parseMetaWebhook,
} from './whatsapp-webhook.types';

type WhatsAppConversationWithMessages = Prisma.WhatsAppConversationGetPayload<{
  include: {
    messages: true;
  };
}>;

type AgentOutboundMessageType =
  'text' | 'template' | 'image' | 'audio' | 'video' | 'document';

class HumanOwnedConversationError extends Error {}

@Injectable()
export class WhatsAppAssistantService {
  private readonly logger = new Logger(WhatsAppAssistantService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly appointmentBookingService: AppointmentBookingService,
    private readonly chatService: ChatService,
    private readonly cryptoService: CryptoService,
    private readonly knowledgeService: KnowledgeService,
    private readonly outboundService: WhatsAppOutboundService,
    private readonly prisma: PrismaService,
    private readonly inboundQueue: WhatsAppInboundQueueService,
    private readonly configService: ConfigService,
    private readonly mediaService: WhatsAppMediaService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async listConfigs(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertWhatsAppEnabled(organizationId);
    const configs = await this.prisma.whatsAppAssistantConfig.findMany({
      where: { organizationId },
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

  async getMessageMedia(currentUser: AuthenticatedUser, messageId: string) {
    const message = await this.prisma.whatsAppMessage.findUnique({
      where: { id: messageId },
    });
    if (
      !message ||
      (!this.isSuperAdmin(currentUser) &&
        message.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('WhatsApp media not found');
    }
    await this.assertWhatsAppEnabled(message.organizationId);
    return this.mediaService.getStoredMedia(message);
  }

  async listTemplates(currentUser: AuthenticatedUser, configId: string) {
    const config = await this.findConfigForActor(currentUser, configId);
    return this.prisma.whatsAppTemplate.findMany({
      where: { configId: config.id },
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
    });
  }

  async syncTemplates(currentUser: AuthenticatedUser, configId: string) {
    const config = await this.findConfigForActor(currentUser, configId);
    if (config.provider !== 'meta') {
      throw new BadRequestException('Template sync is only available for Meta');
    }
    const syncedAt = new Date();
    const templates = await this.outboundService.listMetaTemplates(config);
    await this.prisma.$transaction([
      ...templates.map((template) =>
        this.prisma.whatsAppTemplate.upsert({
          where: {
            configId_name_language: {
              configId: config.id,
              name: template.name,
              language: template.language,
            },
          },
          create: {
            organizationId: config.organizationId,
            configId: config.id,
            providerTemplateId: template.id,
            name: template.name,
            language: template.language,
            status: template.status,
            category: template.category,
            components: this.toJsonArray(template.components),
            syncedAt,
          },
          update: {
            providerTemplateId: template.id,
            status: template.status,
            category: template.category,
            components: this.toJsonArray(template.components),
            syncedAt,
          },
        }),
      ),
      this.prisma.whatsAppTemplate.updateMany({
        where: { configId: config.id, syncedAt: { lt: syncedAt } },
        data: { status: 'STALE' },
      }),
    ]);
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.templates_synced',
      entityType: 'whatsapp_config',
      entityId: config.id,
      metadata: { count: templates.length },
    });
    return this.listTemplates(currentUser, configId);
  }

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendWhatsAppAgentMessageDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.assertWhatsAppEnabled(conversation.organizationId);
    await this.limitAgentOutbound(currentUser, conversation.id);

    const config = await this.prisma.whatsAppAssistantConfig.findUniqueOrThrow({
      where: { id: conversation.configId },
    });
    this.assertSessionWindowOpen(conversation.sessionExpiresAt);
    const result = await this.deliverAgentOutbound({
      currentUser,
      conversation,
      type: 'text',
      content: input.content,
      metadata: {
        agentId: currentUser.sub,
        agentEmail: currentUser.email,
      },
      successAction: 'whatsapp.agent_replied',
      deliver: () =>
        this.outboundService.sendText({
          config,
          to: conversation.contactWaId,
          content: input.content,
        }),
    });

    return {
      conversation: this.toConversationResponse(result.conversation),
      agentMessage: this.toMessageResponse(result.message),
      delivery: result.delivery,
    };
  }

  async sendTemplateMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendWhatsAppTemplateMessageDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.limitAgentOutbound(currentUser, conversation.id);
    const config = await this.prisma.whatsAppAssistantConfig.findUniqueOrThrow({
      where: { id: conversation.configId },
    });
    const template = await this.selectApprovedTemplate(
      config,
      input.templateName,
      input.language,
      conversation.locale,
    );
    const result = await this.deliverAgentOutbound({
      currentUser,
      conversation,
      type: 'template',
      content: template.name,
      metadata: {
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        components: input.components ?? [],
        agentId: currentUser.sub,
      },
      successAction: 'whatsapp.template_sent',
      successMetadata: {
        templateName: template.name,
        language: template.language,
      },
      deliver: () =>
        this.outboundService.sendTemplate({
          config,
          to: conversation.contactWaId,
          name: template.name,
          language: template.language,
          components: input.components,
        }),
    });
    return {
      conversation: this.toConversationResponse(result.conversation),
      message: this.toMessageResponse(result.message),
      delivery: result.delivery,
    };
  }

  async sendMediaMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendWhatsAppMediaMessageDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.limitAgentOutbound(currentUser, conversation.id);
    this.assertSessionWindowOpen(conversation.sessionExpiresAt);
    const config = await this.prisma.whatsAppAssistantConfig.findUniqueOrThrow({
      where: { id: conversation.configId },
    });
    const result = await this.deliverAgentOutbound({
      currentUser,
      conversation,
      type: input.type,
      content: input.caption,
      mediaUrl: input.link,
      metadata: {
        providerMediaId: input.mediaId,
        filename: input.filename,
        agentId: currentUser.sub,
      },
      successAction: 'whatsapp.media_sent',
      successMetadata: { type: input.type },
      deliver: () =>
        this.outboundService.sendMedia({
          config,
          to: conversation.contactWaId,
          ...input,
        }),
    });
    return {
      conversation: this.toConversationResponse(result.conversation),
      message: this.toMessageResponse(result.message),
      delivery: result.delivery,
    };
  }

  private async deliverAgentOutbound(input: {
    currentUser: AuthenticatedUser;
    conversation: WhatsAppConversationWithMessages;
    type: AgentOutboundMessageType;
    content?: string;
    mediaUrl?: string;
    metadata: Record<string, unknown>;
    successAction: string;
    successMetadata?: Record<string, unknown>;
    deliver: () => Promise<WhatsAppOutboundResult>;
  }) {
    const updatedConversation = await this.claimForAgent(
      input.conversation.id,
      input.conversation.assignedAgentId ?? input.currentUser.sub,
    );
    const pendingMessage = await this.prisma.whatsAppMessage.create({
      data: {
        organizationId: input.conversation.organizationId,
        conversationId: input.conversation.id,
        direction: 'outbound',
        role: 'agent',
        type: input.type,
        content: input.content,
        mediaUrl: input.mediaUrl,
        deliveryStatus: 'pending',
        metadata: this.toJsonObject(input.metadata),
      },
    });

    let delivery: WhatsAppOutboundResult;
    try {
      delivery = await input.deliver();
    } catch (error) {
      const failureMessage = 'Provider delivery failed after retry attempts';
      let failurePersisted = false;
      try {
        await this.prisma.whatsAppMessage.update({
          where: { id: pendingMessage.id },
          data: {
            deliveryStatus: 'failed',
            deliveryError: failureMessage,
            deliveryAttempts: { increment: 1 },
            metadata: this.toJsonObject({
              ...input.metadata,
              failedAt: new Date().toISOString(),
            }),
          },
        });
        failurePersisted = true;
        await this.auditService
          .record({
            actor: input.currentUser,
            organizationId: input.conversation.organizationId,
            action: 'whatsapp.agent_delivery_failed',
            entityType: 'whatsapp_message',
            entityId: pendingMessage.id,
            metadata: { type: input.type },
          })
          .catch((auditError) =>
            this.logger.error(
              `Failed to audit WhatsApp delivery failure for ${pendingMessage.id}`,
              auditError instanceof Error ? auditError.stack : undefined,
            ),
          );
      } catch (persistenceError) {
        this.logger.error(
          `Failed to persist WhatsApp delivery failure for ${pendingMessage.id}`,
          persistenceError instanceof Error
            ? persistenceError.stack
            : undefined,
        );
      }
      this.logger.error(
        `Agent WhatsApp delivery failed for ${pendingMessage.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        failurePersisted
          ? 'WhatsApp delivery failed; the failed attempt was recorded'
          : 'WhatsApp delivery failed and failure tracking is temporarily unavailable',
      );
    }
    let message: typeof pendingMessage;
    try {
      message = await this.prisma.whatsAppMessage.update({
        where: { id: pendingMessage.id },
        data: {
          providerMessageId: delivery.providerMessageId,
          deliveryStatus: delivery.status,
          deliveryError: null,
          deliveryAttempts: { increment: 1 },
          metadata: this.toJsonObject({
            ...input.metadata,
            delivery,
          }),
        },
      });
    } catch (error) {
      this.logger.error(
        `Provider accepted WhatsApp message ${pendingMessage.id}, but delivery tracking could not be updated`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'WhatsApp accepted the message, but delivery tracking is temporarily unavailable',
      );
    }
    await this.auditService
      .record({
        actor: input.currentUser,
        organizationId: input.conversation.organizationId,
        action: input.successAction,
        entityType: 'whatsapp_conversation',
        entityId: input.conversation.id,
        metadata: {
          messageId: message.id,
          ...input.successMetadata,
        },
      })
      .catch((auditError) =>
        this.logger.error(
          `Failed to audit successful WhatsApp delivery for ${message.id}`,
          auditError instanceof Error ? auditError.stack : undefined,
        ),
      );
    return {
      conversation: {
        ...updatedConversation,
        messages: [...updatedConversation.messages, message],
      },
      message,
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

  async receiveInboundWebhook(
    configId: string,
    payload: unknown,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
    clientIp = 'unknown',
  ) {
    const config = await this.findActiveConfig(configId);
    this.assertWebhookSignature(config, rawBody, headers);
    await this.limitWebhook(config.id, clientIp);
    await this.assertWhatsAppEnabled(config.organizationId);

    const parsed =
      config.provider === 'meta'
        ? parseMetaWebhook(payload)
        : isLegacyWebhookPayload(payload)
          ? { messages: [payload], phoneNumberIds: [], statuses: [] }
          : parseMetaWebhook(payload);

    if (
      config.provider === 'meta' &&
      config.phoneNumberId &&
      parsed.phoneNumberIds.some((id) => id !== config.phoneNumberId)
    ) {
      throw new ForbiddenException(
        'Webhook phone number does not match this WhatsApp config',
      );
    }

    let accepted = 0;
    let duplicates = 0;
    for (const status of parsed.statuses) {
      await this.recordDeliveryStatus(config.organizationId, status);
    }
    for (const input of parsed.messages) {
      const persisted = await this.persistInboundMessage(config, input);
      if (!persisted.created) {
        duplicates += 1;
      } else {
        accepted += 1;
      }

      if (persisted.processed) continue;
      const queued = await this.inboundQueue.enqueue(persisted.messageId);
      if (!queued) {
        if (this.configService.get<string>('NODE_ENV') === 'production') {
          throw new ServiceUnavailableException(
            'WhatsApp inbound processing queue is unavailable',
          );
        }
        setImmediate(() => {
          void this.processInboundMessage(persisted.messageId).catch((error) =>
            this.logger.error(
              `Inline WhatsApp processing failed for ${persisted.messageId}`,
              error instanceof Error ? error.stack : undefined,
            ),
          );
        });
      }
    }

    return { received: true, accepted, duplicates };
  }

  private async recordDeliveryStatus(
    organizationId: string,
    status: {
      providerMessageId: string;
      status: string;
      timestamp?: string;
      recipientWaId?: string;
      errors?: unknown[];
    },
  ) {
    const message = await this.prisma.whatsAppMessage.findFirst({
      where: {
        organizationId,
        direction: 'outbound',
        providerMessageId: status.providerMessageId,
      },
    });
    if (!message) return;

    const timestampSeconds = Number(status.timestamp);
    const callbackAt = Number.isFinite(timestampSeconds)
      ? new Date(timestampSeconds * 1000)
      : new Date();
    const deliveredAt = ['delivered', 'read'].includes(status.status)
      ? callbackAt
      : undefined;
    await this.prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        deliveryStatus: status.status,
        deliveryError:
          status.status === 'failed'
            ? 'Provider reported delivery failure'
            : null,
        deliveredAt,
        metadata: this.toJsonObject({
          ...this.toRecord(message.metadata),
          deliveryStatus: status,
        }),
      },
    });
  }

  async processInboundMessage(messageId: string): Promise<void> {
    const inboundMessage = await this.prisma.whatsAppMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { config: true } } },
    });

    if (
      !inboundMessage ||
      inboundMessage.direction !== 'inbound' ||
      inboundMessage.processedAt
    ) {
      return;
    }

    const { conversation } = inboundMessage;
    if (
      conversation.status !== 'open' ||
      Boolean(conversation.assignedAgentId)
    ) {
      await this.markInboundProcessed(messageId);
      return;
    }

    try {
      const metadata = this.toRecord(inboundMessage.metadata);
      const isMedia = [
        'image',
        'audio',
        'video',
        'document',
        'sticker',
      ].includes(inboundMessage.type);
      const mediaContext = isMedia
        ? await this.mediaService.downloadStoreAndDescribe({
            config: conversation.config,
            message: inboundMessage,
          })
        : null;
      if (isMedia && !mediaContext) {
        await this.prisma.whatsAppConversation.update({
          where: { id: conversation.id },
          data: { status: 'waiting_for_agent' },
        });
        await this.markInboundProcessed(messageId);
        return;
      }
      const question =
        [inboundMessage.content, mediaContext].filter(Boolean).join('\n\n') ||
        this.fallbackMediaQuestion(inboundMessage.type);
      const locale = await this.chatService.detectLanguage(
        conversation.organizationId,
        question,
        conversation.locale || conversation.config.defaultLocale,
      );
      if (locale !== conversation.locale) {
        await this.prisma.whatsAppConversation.update({
          where: { id: conversation.id },
          data: { locale },
        });
      }
      await this.createAssistantReply(
        conversation.config,
        conversation.organizationId,
        conversation.id,
        conversation.contactWaId,
        question,
        this.readAppointmentAction(metadata),
        locale,
      );
      await this.markInboundProcessed(messageId);
    } catch (error) {
      if (error instanceof HumanOwnedConversationError) {
        await this.markInboundProcessed(messageId);
        return;
      }
      await this.prisma.whatsAppMessage.update({
        where: { id: messageId },
        data: {
          processingAttempts: { increment: 1 },
          processingError: this.errorMessage(error).slice(0, 2000),
        },
      });
      throw error;
    }
  }

  private async persistInboundMessage(
    config: WhatsAppAssistantConfig,
    input: WhatsAppInboundWebhookDto,
  ): Promise<{ messageId: string; created: boolean; processed: boolean }> {
    if (!input.providerMessageId) {
      throw new BadRequestException('WhatsApp message id is required');
    }

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

    if (this.matchesHandoffKeyword(config.settings, input.content)) {
      await this.prisma.whatsAppConversation.update({
        where: { id: conversation.id },
        data: { status: 'waiting_for_agent' },
      });
    }

    let inboundMessage: Prisma.WhatsAppMessageGetPayload<object>;
    try {
      inboundMessage = await this.prisma.whatsAppMessage.create({
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
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const existing = await this.prisma.whatsAppMessage.findFirstOrThrow({
        where: {
          organizationId: config.organizationId,
          direction: 'inbound',
          providerMessageId: input.providerMessageId,
        },
      });
      return {
        messageId: existing.id,
        created: false,
        processed: Boolean(existing.processedAt),
      };
    }

    await this.auditService.record({
      organizationId: config.organizationId,
      action: 'whatsapp.inbound_message_received',
      entityType: 'whatsapp_conversation',
      entityId: conversation.id,
      metadata: {
        contactWaId: input.contactWaId,
        messageId: inboundMessage.id,
      },
    });

    return { messageId: inboundMessage.id, created: true, processed: false };
  }

  private async createAssistantReply(
    config: WhatsAppAssistantConfig,
    organizationId: string,
    conversationId: string,
    contactWaId: string,
    content: string,
    appointmentAction?: AppointmentActionDto,
    locale = 'en',
  ): Promise<{
    message: Prisma.WhatsAppMessageGetPayload<object>;
    delivery: WhatsAppOutboundResult;
  }> {
    if (appointmentAction) {
      if (!(await this.isAiOwnedConversation(conversationId))) {
        throw new HumanOwnedConversationError();
      }
      const result = await this.appointmentBookingService.executeAction(
        organizationId,
        appointmentAction,
      );
      const answer = this.appointmentBookingService.formatActionResult(result);
      if (!(await this.isAiOwnedConversation(conversationId))) {
        throw new HumanOwnedConversationError();
      }
      const delivery = await this.outboundService.sendText({
        config,
        to: contactWaId,
        content: answer,
      });
      const message = await this.prisma.whatsAppMessage.create({
        data: {
          organizationId,
          conversationId,
          direction: 'outbound',
          role: 'assistant',
          type: 'text',
          providerMessageId: delivery.providerMessageId,
          content: answer,
          metadata: this.toJsonObject({ appointmentAction, delivery }),
        },
      });
      return { message, delivery };
    }

    const systemUser = this.createSystemUser(organizationId);
    const searchResults = await this.knowledgeService.search(systemUser, {
      query: content,
      limit: 5,
      productKey: 'whatsapp_assistant',
    });
    const chatResult = await this.chatService.answerWithContext({
      organizationId,
      question: `Reply in locale ${locale}. Customer message: ${content}`,
      safeFallback: true,
      context: searchResults.map((result) => ({
        content: result.content,
        score: result.score,
      })),
    });

    if (!(await this.isAiOwnedConversation(conversationId))) {
      throw new HumanOwnedConversationError();
    }
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
          adapter: chatResult.adapter,
          usedFallback: chatResult.usedFallback,
          error: chatResult.error,
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

  private readAppointmentAction(
    metadata?: Record<string, unknown>,
  ): AppointmentActionDto | undefined {
    const value = metadata?.appointmentAction;
    return value && !Array.isArray(value) && typeof value === 'object'
      ? (value as AppointmentActionDto)
      : undefined;
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

  private assertWebhookSignature(
    config: WhatsAppAssistantConfig,
    rawBody?: Buffer,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    if (!config.appSecretEncrypted) {
      throw new ForbiddenException(
        'WhatsApp webhook app secret is not configured',
      );
    }

    const signature = this.getHeader(headers, 'x-hub-signature-256');
    if (!rawBody || !signature?.startsWith('sha256=')) {
      throw new ForbiddenException('Invalid WhatsApp webhook signature');
    }

    const secret = this.cryptoService.decrypt(config.appSecretEncrypted);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const actual = signature.slice('sha256='.length);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');

    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new ForbiddenException('Invalid WhatsApp webhook signature');
    }
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
    name: string,
  ): string | undefined {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private assertSessionWindowOpen(sessionExpiresAt: Date | null) {
    if (!sessionExpiresAt || sessionExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'The WhatsApp 24-hour customer-service window is closed; use an approved template message',
      );
    }
  }

  private async isAiOwnedConversation(conversationId: string) {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: { status: true, assignedAgentId: true },
    });
    return conversation?.status === 'open' && !conversation.assignedAgentId;
  }

  private async markInboundProcessed(messageId: string) {
    await this.prisma.whatsAppMessage.update({
      where: { id: messageId },
      data: {
        processedAt: new Date(),
        processingAttempts: { increment: 1 },
        processingError: null,
      },
    });
  }

  private matchesHandoffKeyword(
    settings: Prisma.JsonValue,
    content?: string,
  ): boolean {
    if (!content) return false;
    const configured = this.toRecord(settings).handoffKeywords;
    if (!Array.isArray(configured)) return false;
    const normalized = content.toLocaleLowerCase();
    return configured.some(
      (keyword) =>
        typeof keyword === 'string' &&
        keyword.trim().length > 0 &&
        normalized.includes(keyword.trim().toLocaleLowerCase()),
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async selectApprovedTemplate(
    config: WhatsAppAssistantConfig,
    name: string,
    requestedLanguage: string | undefined,
    conversationLocale: string,
  ) {
    const templates = await this.prisma.whatsAppTemplate.findMany({
      where: {
        configId: config.id,
        name,
        status: { equals: 'APPROVED', mode: 'insensitive' },
      },
    });
    if (!templates.length) {
      throw new BadRequestException(
        `No approved WhatsApp template named ${name} is synced`,
      );
    }
    const preferences = [
      requestedLanguage,
      conversationLocale,
      config.defaultLocale,
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => [value, value.split(/[-_]/)[0]]);
    const selected = preferences
      .map((locale) =>
        templates.find(
          (template) =>
            template.language.toLowerCase() === locale.toLowerCase(),
        ),
      )
      .find(Boolean);
    if (!selected) {
      throw new BadRequestException(
        `Template ${name} has no approved language for ${preferences[0] ?? 'the conversation locale'}`,
      );
    }
    return selected;
  }

  private async limitWebhook(configId: string, clientIp: string) {
    const windowSeconds = this.configService.get<number>(
      'WHATSAPP_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const limit = this.configService.get<number>(
      'WHATSAPP_WEBHOOK_MAX_REQUESTS_PER_WINDOW',
      300,
    );
    await Promise.all([
      this.rateLimitService.consume(
        `whatsapp-webhook:config:${configId}`,
        limit,
        windowSeconds,
      ),
      this.rateLimitService.consume(
        `whatsapp-webhook:ip:${clientIp}`,
        limit,
        windowSeconds,
      ),
    ]);
  }

  private async limitAgentOutbound(
    currentUser: AuthenticatedUser,
    conversationId: string,
  ) {
    const windowSeconds = this.configService.get<number>(
      'WHATSAPP_AGENT_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const limit = this.configService.get<number>(
      'WHATSAPP_AGENT_MAX_SENDS_PER_WINDOW',
      30,
    );
    await Promise.all([
      this.rateLimitService.consume(
        `whatsapp-agent:user:${currentUser.sub}`,
        limit,
        windowSeconds,
      ),
      this.rateLimitService.consume(
        `whatsapp-agent:conversation:${conversationId}`,
        limit,
        windowSeconds,
      ),
    ]);
  }

  private claimForAgent(conversationId: string, agentId: string) {
    return this.prisma.whatsAppConversation.update({
      where: { id: conversationId },
      data: {
        status: 'waiting_for_agent',
        assignedAgentId: agentId,
        lastMessageAt: new Date(),
      },
      include: this.conversationInclude(),
    });
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

  private toJsonArray(value: unknown[] | undefined): Prisma.InputJsonArray {
    return (value ?? []) as Prisma.InputJsonArray;
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
