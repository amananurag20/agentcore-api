import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WhatsAppAssistantConfig } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChatService, type ChatHistoryMessage } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { AppointmentBookingService } from '../appointment-booking/appointment-booking.service';
import { AppointmentActionDto } from '../appointment-booking/dto/appointment-action.dto';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import {
  KnowledgeSearchRow,
  KnowledgeService,
} from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import {
  AssignWhatsAppConversationDto,
  CreateWhatsAppConfigDto,
  CreateWhatsAppTemplateDto,
  ListWhatsAppConversationsDto,
  SendWhatsAppAgentMessageDto,
  SendWhatsAppMediaMessageDto,
  SendWhatsAppTemplateMessageDto,
  UpdateWhatsAppConfigDto,
  UpdateWhatsAppConversationStatusDto,
  UpdateWhatsAppTemplateDto,
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

type WhatsAppMemoryPolicy = {
  enabled: boolean;
  recentMessageLimit: number;
  lowConfidenceAction: 'clarify' | 'handoff';
  maxClarificationAttempts: number;
};

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

    const settings = await this.normalizeWhatsAppSettings(
      organizationId,
      input.settings,
    );

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
        settings: this.toJsonObject(settings),
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
    const settings = input.settings
      ? await this.normalizeWhatsAppSettings(
          existing.organizationId,
          input.settings,
          this.toRecord(existing.settings),
        )
      : undefined;

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
        settings: settings ? this.toJsonObject(settings) : undefined,
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

  async deleteConfig(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findConfigForActor(currentUser, id);
    if (config.status !== 'inactive') {
      throw new ConflictException(
        'Deactivate the WhatsApp configuration before deleting it',
      );
    }
    const conversationCount = await this.prisma.whatsAppConversation.count({
      where: { configId: config.id },
    });
    if (conversationCount > 0) {
      throw new ConflictException(
        'Cannot delete a WhatsApp configuration with conversation history; set it to inactive instead',
      );
    }

    await this.prisma.whatsAppAssistantConfig.delete({
      where: { id: config.id },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.config_deleted',
      entityType: 'whatsapp_config',
      entityId: config.id,
      metadata: { name: config.name, provider: config.provider },
    });
    return { deleted: true, id: config.id };
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

  async createTemplate(
    currentUser: AuthenticatedUser,
    configId: string,
    input: CreateWhatsAppTemplateDto,
  ) {
    const config = await this.findConfigForActor(currentUser, configId);
    if (config.provider !== 'meta') {
      throw new BadRequestException(
        'Template drafts are only available for Meta configurations',
      );
    }
    const components = this.normalizeTemplateComponents(
      input.category,
      input.components,
    );
    try {
      const template = await this.prisma.whatsAppTemplate.create({
        data: {
          organizationId: config.organizationId,
          configId: config.id,
          name: input.name,
          language: input.language,
          category: input.category,
          components: this.toJsonArray(components),
          status: 'DRAFT',
          source: 'local',
        },
      });
      await this.auditService.record({
        actor: currentUser,
        organizationId: config.organizationId,
        action: 'whatsapp.template_created',
        entityType: 'whatsapp_template',
        entityId: template.id,
        metadata: {
          configId,
          name: template.name,
          language: template.language,
        },
      });
      return template;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `A ${input.language} template named ${input.name} already exists`,
        );
      }
      throw error;
    }
  }

  async updateTemplate(
    currentUser: AuthenticatedUser,
    configId: string,
    templateId: string,
    input: UpdateWhatsAppTemplateDto,
  ) {
    const { config, template } = await this.findTemplateForActor(
      currentUser,
      configId,
      templateId,
    );
    if (
      template.status.toUpperCase() !== 'DRAFT' ||
      template.providerTemplateId
    ) {
      throw new ConflictException(
        'Only local draft templates can be edited; duplicate this template to create a new version',
      );
    }
    const category = input.category ?? template.category ?? 'UTILITY';
    const components = this.normalizeTemplateComponents(
      category,
      input.components ??
        (this.toJsonArray(template.components) as unknown as Record<
          string,
          unknown
        >[]),
    );
    try {
      const updated = await this.prisma.whatsAppTemplate.update({
        where: { id: template.id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.category ? { category: input.category } : {}),
          category,
          components: this.toJsonArray(components),
          rejectionReason: null,
        },
      });
      await this.auditService.record({
        actor: currentUser,
        organizationId: config.organizationId,
        action: 'whatsapp.template_updated',
        entityType: 'whatsapp_template',
        entityId: template.id,
        metadata: { configId },
      });
      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A template with this name and language already exists',
        );
      }
      throw error;
    }
  }

  async submitTemplate(
    currentUser: AuthenticatedUser,
    configId: string,
    templateId: string,
  ) {
    const { config, template } = await this.findTemplateForActor(
      currentUser,
      configId,
      templateId,
    );
    if (config.provider !== 'meta') {
      throw new BadRequestException(
        'Template submission is only available for Meta configurations',
      );
    }
    if (
      template.status.toUpperCase() !== 'DRAFT' ||
      template.providerTemplateId
    ) {
      throw new ConflictException('Only an unsubmitted draft can be submitted');
    }
    const components = this.normalizeTemplateComponents(
      template.category ?? 'UTILITY',
      this.toJsonArray(template.components) as unknown as Record<
        string,
        unknown
      >[],
    );
    const submitted = await this.outboundService.createMetaTemplate(config, {
      name: template.name,
      language: template.language,
      category: template.category ?? 'UTILITY',
      components,
    });
    const now = new Date();
    const updated = await this.prisma.whatsAppTemplate.update({
      where: { id: template.id },
      data: {
        providerTemplateId: submitted.id,
        status: submitted.status ?? 'PENDING',
        category: submitted.category ?? template.category,
        submittedAt: now,
        syncedAt: now,
        rejectionReason: null,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.template_submitted',
      entityType: 'whatsapp_template',
      entityId: template.id,
      metadata: {
        configId,
        providerTemplateId: submitted.id,
        status: updated.status,
      },
    });
    return updated;
  }

  async uploadTemplateMedia(
    currentUser: AuthenticatedUser,
    configId: string,
    file?: Express.Multer.File,
  ) {
    const config = await this.findConfigForActor(currentUser, configId);
    if (!file) throw new BadRequestException('A media file is required');
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'video/mp4',
      'application/pdf',
    ]);
    if (!allowedMimeTypes.has(file.mimetype)) {
      throw new BadRequestException(
        'Template media must be a JPEG, PNG, MP4 video, or PDF document',
      );
    }
    if (!file.size || file.size > 16 * 1024 * 1024) {
      throw new BadRequestException(
        'Template sample media must be between 1 byte and 16 MB',
      );
    }
    this.assertTemplateMediaSignature(file.mimetype, file.buffer);
    const uploaded = await this.outboundService.uploadTemplateMedia(config, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.template_media_uploaded',
      entityType: 'whatsapp_config',
      entityId: config.id,
      metadata: {
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        size: uploaded.size,
      },
    });
    return uploaded;
  }

  async deleteTemplate(
    currentUser: AuthenticatedUser,
    configId: string,
    templateId: string,
  ) {
    const { config, template } = await this.findTemplateForActor(
      currentUser,
      configId,
      templateId,
    );
    if (
      template.providerTemplateId ||
      template.status.toUpperCase() !== 'DRAFT'
    ) {
      throw new ConflictException(
        'Only local drafts can be deleted here; manage submitted templates in Meta and synchronize',
      );
    }
    await this.prisma.whatsAppTemplate.delete({ where: { id: template.id } });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'whatsapp.template_deleted',
      entityType: 'whatsapp_template',
      entityId: template.id,
      metadata: { configId, name: template.name, language: template.language },
    });
    return { deleted: true, id: template.id };
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
            source: 'meta',
            rejectionReason: template.rejected_reason,
            syncedAt,
          },
          update: {
            providerTemplateId: template.id,
            status: template.status,
            category: template.category,
            components: this.toJsonArray(template.components),
            rejectionReason: template.rejected_reason,
            syncedAt,
          },
        }),
      ),
      this.prisma.whatsAppTemplate.updateMany({
        where: {
          configId: config.id,
          providerTemplateId: { not: null },
          syncedAt: { lt: syncedAt },
        },
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
    const components = this.normalizeTemplateSendComponents(
      template.category ?? 'UTILITY',
      this.toJsonArray(template.components) as unknown as Record<
        string,
        unknown
      >[],
      input.components ?? [],
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
        components,
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
          components: components.length ? components : undefined,
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
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ) {
    const config = await this.findActiveConfig(configId);
    await this.assertWhatsAppEnabled(config.organizationId);

    if (mode !== 'subscribe' || !challenge) {
      throw new BadRequestException('Invalid WhatsApp webhook verification');
    }
    if (!config.webhookVerifyTokenEncrypted) {
      throw new ForbiddenException(
        'WhatsApp webhook verify token is not configured',
      );
    }
    if (
      !verifyToken ||
      verifyToken !==
        this.cryptoService.decrypt(config.webhookVerifyTokenEncrypted)
    ) {
      throw new ForbiddenException('Invalid WhatsApp webhook verify token');
    }

    return challenge;
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
        inboundMessage.id,
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

  async recoverInboundFailure(
    messageId: string,
    error: unknown,
  ): Promise<void> {
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
    const claimed = await this.prisma.whatsAppConversation.updateMany({
      where: {
        id: conversation.id,
        status: 'open',
        assignedAgentId: null,
      },
      data: { status: 'waiting_for_agent' },
    });
    if (claimed.count === 0) {
      await this.markInboundProcessed(messageId);
      return;
    }

    const content = this.configService.get<string>(
      'WHATSAPP_PROCESSING_FAILURE_MESSAGE',
      'I could not complete that request right now. I have asked a human agent to help you.',
    );
    try {
      const delivery = await this.outboundService.sendText({
        config: conversation.config,
        to: conversation.contactWaId,
        content,
      });
      await this.prisma.whatsAppMessage.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          direction: 'outbound',
          role: 'assistant',
          type: 'text',
          providerMessageId: delivery.providerMessageId,
          content,
          deliveryStatus: delivery.status,
          deliveryAttempts: 1,
          metadata: this.toJsonObject({
            usedFallback: true,
            handoffRequested: true,
            failureCode: 'automatic_reply_failed',
            delivery,
          }),
        },
      });
    } catch (deliveryError) {
      await this.prisma.whatsAppMessage.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          direction: 'outbound',
          role: 'assistant',
          type: 'text',
          content,
          deliveryStatus: 'failed',
          deliveryError: 'Provider delivery failed after retry attempts',
          deliveryAttempts: 1,
          metadata: this.toJsonObject({
            usedFallback: true,
            handoffRequested: true,
            failureCode: 'automatic_reply_and_notice_failed',
          }),
        },
      });
      this.logger.error(
        `WhatsApp failure notice could not be delivered for ${messageId}`,
        deliveryError instanceof Error ? deliveryError.stack : undefined,
      );
    }

    const processingError = this.errorMessage(error).slice(0, 2000);
    await this.prisma.whatsAppMessage.update({
      where: { id: messageId },
      data: { processedAt: new Date(), processingError },
    });
    await this.auditService
      .record({
        organizationId: conversation.organizationId,
        action: 'whatsapp.auto_handoff_requested',
        entityType: 'whatsapp_conversation',
        entityId: conversation.id,
        metadata: { reason: 'automatic_reply_failed', error: processingError },
      })
      .catch((auditError) =>
        this.logger.warn(
          `Could not audit WhatsApp failure handoff for ${conversation.id}: ${this.errorMessage(auditError)}`,
        ),
      );
  }

  private async persistInboundMessage(
    config: WhatsAppAssistantConfig,
    input: WhatsAppInboundWebhookDto,
  ): Promise<{ messageId: string; created: boolean; processed: boolean }> {
    if (!input.providerMessageId) {
      throw new BadRequestException('WhatsApp message id is required');
    }

    // Deduplicate before touching the conversation so a provider retry cannot
    // extend the customer-service window or reorder the inbox.
    const existingMessage = await this.prisma.whatsAppMessage.findFirst({
      where: {
        organizationId: config.organizationId,
        direction: 'inbound',
        providerMessageId: input.providerMessageId,
      },
      select: { id: true, processedAt: true },
    });
    if (existingMessage) {
      return {
        messageId: existingMessage.id,
        created: false,
        processed: Boolean(existingMessage.processedAt),
      };
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
    inboundMessageId?: string,
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

    const memoryPolicy = this.readWhatsAppMemoryPolicy(config.settings);
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const conversationMemory = this.readConversationMemory(
      conversation?.metadata ?? {},
    );
    let activeTopicQuery = conversationMemory.activeTopicQuery;
    let clarificationRequested = false;
    let clarificationAttempts = 0;
    let shouldAutoHandoff = false;
    let searchResults: KnowledgeSearchRow[] = [];
    let answer: string;
    let responseMetadata: Record<string, unknown>;

    const conversationalResult =
      this.chatService.answerConversationally(content);
    if (conversationalResult) {
      answer = conversationalResult.answer;
      responseMetadata = {
        model: conversationalResult.model,
        provider: conversationalResult.provider,
        adapter: conversationalResult.adapter,
        usedFallback: false,
        handledWithoutKnowledge: true,
        retrieval: {
          candidateCount: 0,
          acceptedCount: 0,
          skipped: 'conversational_intent',
        },
      };
    } else {
      const recentMessages = memoryPolicy.enabled
        ? await this.prisma.whatsAppMessage.findMany({
            where: {
              conversationId,
              organizationId,
              id: inboundMessageId ? { not: inboundMessageId } : undefined,
              role: { in: ['contact', 'assistant'] },
              content: { not: null },
            },
            select: { role: true, content: true, metadata: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: memoryPolicy.recentMessageLimit,
          })
        : [];
      const conversationHistory: ChatHistoryMessage[] = [...recentMessages]
        .reverse()
        .flatMap((message) =>
          message.content
            ? [
                {
                  role:
                    message.role === 'contact'
                      ? ('user' as const)
                      : ('assistant' as const),
                  content: message.content,
                },
              ]
            : [],
        );
      const previousContactMessage = [...conversationHistory]
        .reverse()
        .find((message) => message.role === 'user');
      const isContextualFollowUp = this.isContextualFollowUp(
        content,
        conversationHistory.length > 0,
      );
      const storedTopic = recentMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => this.toRecord(message.metadata).retrieval)
        .find(
          (retrieval) =>
            retrieval &&
            !Array.isArray(retrieval) &&
            typeof retrieval === 'object' &&
            typeof (retrieval as Record<string, unknown>).topicQuery ===
              'string',
        );
      const persistedTopic =
        activeTopicQuery ??
        (storedTopic && !Array.isArray(storedTopic)
          ? (storedTopic as Record<string, unknown>).topicQuery
          : null);
      const topicQuery =
        typeof persistedTopic === 'string'
          ? persistedTopic
          : (previousContactMessage?.content ?? content);
      const retrievalQuery = isContextualFollowUp
        ? `${topicQuery}\nFollow-up request: ${content}`
        : content;
      const proposedTopicQuery = isContextualFollowUp ? topicQuery : content;
      const systemUser = this.createSystemUser(organizationId);
      const candidates = await this.knowledgeService.search(systemUser, {
        query: retrievalQuery,
        limit: 10,
        productKey: 'whatsapp_assistant',
        folderIds: this.readWhatsAppKnowledgeFolderIds(config.settings),
      });
      const minimumScore = this.configService.get<number>(
        'WHATSAPP_MIN_SIMILARITY_SCORE',
        0.35,
      );
      const lexicalRescueMargin = this.configService.get<number>(
        'WHATSAPP_LEXICAL_RESCUE_MARGIN',
        0.05,
      );
      searchResults = candidates
        .filter(
          (result) =>
            result.score >= minimumScore ||
            (result.score >= minimumScore - lexicalRescueMargin &&
              this.hasLexicalSupport(retrievalQuery, result.content)),
        )
        .slice(0, 5);
      const retrievalMetadata = {
        candidateCount: candidates.length,
        acceptedCount: searchResults.length,
        minimumScore,
        lexicalRescueMargin,
        lexicalRescueCount: searchResults.filter(
          (result) => result.score < minimumScore,
        ).length,
        topScore: candidates[0]?.score ?? null,
        contextualFollowUp: isContextualFollowUp,
        topicQuery: proposedTopicQuery,
      };

      if (!searchResults.length) {
        const previousMemory = this.readPreviousAssistantMemory(recentMessages);
        const lowConfidence = this.resolveLowConfidenceDecision(
          memoryPolicy,
          conversationMemory.clarificationRequested
            ? conversationMemory
            : previousMemory,
        );
        clarificationAttempts = lowConfidence.attempts;
        shouldAutoHandoff = lowConfidence.shouldHandoff;
        clarificationRequested = !shouldAutoHandoff;
        answer = shouldAutoHandoff
          ? 'I cannot confirm that from the available knowledge right now. I have requested a human agent to help you.'
          : 'I could not find enough relevant information to answer that confidently. Could you rephrase your question or add a little more detail?';
        responseMetadata = {
          model: 'local-guardrail',
          provider: 'local',
          adapter: 'retrieval-guardrail',
          usedFallback: true,
          handledWithoutKnowledge: false,
          retrieval: retrievalMetadata,
          memory: { clarificationRequested, clarificationAttempts },
        };
      } else {
        activeTopicQuery = proposedTopicQuery;
        const chatResult = await this.chatService.answerWithContext({
          organizationId,
          question: `Reply in locale ${locale}. Customer message: ${content}`,
          history: conversationHistory,
          safeFallback: true,
          context: searchResults.map((result) => ({
            content: result.content,
            score: result.score,
          })),
        });
        answer = chatResult.answer;
        responseMetadata = {
          model: chatResult.model,
          provider: chatResult.provider,
          adapter: chatResult.adapter,
          usedFallback: chatResult.usedFallback,
          handledWithoutKnowledge: chatResult.handledWithoutKnowledge ?? false,
          error: chatResult.error,
          retrieval: retrievalMetadata,
          memory: { clarificationRequested: false, clarificationAttempts: 0 },
        };
        shouldAutoHandoff =
          this.configService.get<boolean>(
            'WHATSAPP_AUTO_HANDOFF_ON_FAILURE',
            true,
          ) && chatResult.usedFallback;
      }
    }

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
        deliveryStatus: delivery.status,
        deliveryAttempts: 1,
        metadata: this.toJsonObject({
          ...responseMetadata,
          delivery,
          citations: searchResults.map((result) => ({
            chunkId: result.id,
            score: result.score,
          })),
        }),
      },
    });

    await this.prisma.whatsAppConversation.updateMany({
      where: {
        id: conversationId,
        status: 'open',
        assignedAgentId: null,
      },
      data: {
        status: shouldAutoHandoff ? 'waiting_for_agent' : 'open',
        metadata: this.toJsonObject({
          ...this.toRecord(conversation?.metadata ?? {}),
          memory: {
            activeTopicQuery,
            clarificationRequested,
            clarificationAttempts,
          },
        }),
      },
    });

    if (shouldAutoHandoff) {
      await this.auditService.record({
        organizationId,
        action: 'whatsapp.auto_handoff_requested',
        entityType: 'whatsapp_conversation',
        entityId: conversationId,
        metadata: { reason: 'low_confidence_or_provider_failure' },
      });
    }

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

  private async findTemplateForActor(
    currentUser: AuthenticatedUser,
    configId: string,
    templateId: string,
  ) {
    const config = await this.findConfigForActor(currentUser, configId);
    const template = await this.prisma.whatsAppTemplate.findFirst({
      where: { id: templateId, configId: config.id },
    });
    if (!template) {
      throw new NotFoundException('WhatsApp template not found');
    }
    return { config, template };
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

  private async normalizeWhatsAppSettings(
    organizationId: string,
    input: Record<string, unknown> | undefined,
    existing: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const settings = { ...existing, ...(input ?? {}) };
    const policy = this.readWhatsAppMemoryPolicy(settings, true);
    const knowledgeScope = settings.knowledgeScope ?? 'all';
    if (knowledgeScope !== 'all' && knowledgeScope !== 'folders') {
      throw new BadRequestException('knowledgeScope must be all or folders');
    }
    const rawFolderIds = settings.folderIds ?? [];
    if (
      !Array.isArray(rawFolderIds) ||
      rawFolderIds.some(
        (folderId) => typeof folderId !== 'string' || !folderId.trim(),
      )
    ) {
      throw new BadRequestException('folderIds must be an array of IDs');
    }
    const folderIds = [
      ...new Set(rawFolderIds.map((folderId) => String(folderId).trim())),
    ];
    await this.assertWhatsAppKnowledgeFolders(
      organizationId,
      knowledgeScope,
      folderIds,
    );

    const rawKeywords = settings.handoffKeywords ?? [];
    if (
      !Array.isArray(rawKeywords) ||
      rawKeywords.some((keyword) => typeof keyword !== 'string')
    ) {
      throw new BadRequestException(
        'handoffKeywords must be an array of strings',
      );
    }

    return {
      ...settings,
      handoffKeywords: rawKeywords
        .map((keyword) => String(keyword).trim())
        .filter(Boolean)
        .slice(0, 50),
      knowledgeScope,
      folderIds: knowledgeScope === 'folders' ? folderIds : [],
      memoryEnabled: policy.enabled,
      recentMessageLimit: policy.recentMessageLimit,
      lowConfidenceAction: policy.lowConfidenceAction,
      maxClarificationAttempts: policy.maxClarificationAttempts,
    };
  }

  private async assertWhatsAppKnowledgeFolders(
    organizationId: string,
    knowledgeScope: 'all' | 'folders',
    folderIds: string[],
  ) {
    if (knowledgeScope === 'all') return;
    if (!folderIds.length) {
      throw new BadRequestException(
        'Select at least one knowledge folder for WhatsApp',
      );
    }
    const count = await this.prisma.knowledgeFolder.count({
      where: { organizationId, id: { in: folderIds } },
    });
    if (count !== folderIds.length) {
      throw new BadRequestException(
        'WhatsApp knowledge folder scope is invalid',
      );
    }
  }

  private readWhatsAppKnowledgeFolderIds(
    value: Prisma.JsonValue,
  ): string[] | undefined {
    const settings = this.toRecord(value);
    if (settings.knowledgeScope !== 'folders') return undefined;
    return Array.isArray(settings.folderIds)
      ? settings.folderIds.filter(
          (folderId): folderId is string => typeof folderId === 'string',
        )
      : undefined;
  }

  private readWhatsAppMemoryPolicy(
    value: Prisma.JsonValue | Record<string, unknown>,
    strict = false,
  ): WhatsAppMemoryPolicy {
    const settings = this.toRecord(value as Prisma.JsonValue);
    const enabled = settings.memoryEnabled ?? true;
    const recentMessageLimit = settings.recentMessageLimit ?? 8;
    const lowConfidenceAction = settings.lowConfidenceAction ?? 'clarify';
    const maxClarificationAttempts = settings.maxClarificationAttempts ?? 2;

    if (strict && typeof enabled !== 'boolean') {
      throw new BadRequestException('memoryEnabled must be a boolean');
    }
    if (
      strict &&
      (!Number.isInteger(recentMessageLimit) ||
        Number(recentMessageLimit) < 4 ||
        Number(recentMessageLimit) > 20)
    ) {
      throw new BadRequestException(
        'recentMessageLimit must be an integer between 4 and 20',
      );
    }
    if (
      strict &&
      lowConfidenceAction !== 'clarify' &&
      lowConfidenceAction !== 'handoff'
    ) {
      throw new BadRequestException(
        'lowConfidenceAction must be clarify or handoff',
      );
    }
    if (
      strict &&
      (!Number.isInteger(maxClarificationAttempts) ||
        Number(maxClarificationAttempts) < 1 ||
        Number(maxClarificationAttempts) > 3)
    ) {
      throw new BadRequestException(
        'maxClarificationAttempts must be an integer between 1 and 3',
      );
    }

    return {
      enabled: typeof enabled === 'boolean' ? enabled : true,
      recentMessageLimit: Number.isInteger(recentMessageLimit)
        ? Math.min(20, Math.max(4, Number(recentMessageLimit)))
        : 8,
      lowConfidenceAction:
        lowConfidenceAction === 'handoff' ? 'handoff' : 'clarify',
      maxClarificationAttempts: Number.isInteger(maxClarificationAttempts)
        ? Math.min(3, Math.max(1, Number(maxClarificationAttempts)))
        : 2,
    };
  }

  private readConversationMemory(value: Prisma.JsonValue): {
    activeTopicQuery: string | null;
    clarificationRequested: boolean;
    clarificationAttempts: number;
  } {
    const memory = this.toRecord(value).memory;
    if (!memory || Array.isArray(memory) || typeof memory !== 'object') {
      return {
        activeTopicQuery: null,
        clarificationRequested: false,
        clarificationAttempts: 0,
      };
    }
    const record = memory as Record<string, unknown>;
    return {
      activeTopicQuery:
        typeof record.activeTopicQuery === 'string' &&
        record.activeTopicQuery.trim()
          ? record.activeTopicQuery
          : null,
      clarificationRequested: record.clarificationRequested === true,
      clarificationAttempts:
        typeof record.clarificationAttempts === 'number' &&
        Number.isInteger(record.clarificationAttempts)
          ? Math.max(0, record.clarificationAttempts)
          : 0,
    };
  }

  private readPreviousAssistantMemory(
    messages: Array<{ role: string; metadata: Prisma.JsonValue }>,
  ): { clarificationRequested: boolean; clarificationAttempts: number } {
    const previousAssistant = messages.find(
      (message) => message.role === 'assistant',
    );
    const memory = previousAssistant
      ? this.toRecord(previousAssistant.metadata).memory
      : null;
    if (!memory || Array.isArray(memory) || typeof memory !== 'object') {
      return { clarificationRequested: false, clarificationAttempts: 0 };
    }
    const record = memory as Record<string, unknown>;
    return {
      clarificationRequested: record.clarificationRequested === true,
      clarificationAttempts:
        typeof record.clarificationAttempts === 'number' &&
        Number.isInteger(record.clarificationAttempts)
          ? Math.max(0, record.clarificationAttempts)
          : 0,
    };
  }

  private resolveLowConfidenceDecision(
    policy: WhatsAppMemoryPolicy,
    previous: {
      clarificationRequested: boolean;
      clarificationAttempts: number;
    },
  ): { attempts: number; shouldHandoff: boolean } {
    const attempts = previous.clarificationRequested
      ? previous.clarificationAttempts + 1
      : 1;
    return {
      attempts,
      shouldHandoff:
        policy.lowConfidenceAction === 'handoff' ||
        attempts >= policy.maxClarificationAttempts,
    };
  }

  private isContextualFollowUp(
    content: string,
    hasConversationHistory: boolean,
  ): boolean {
    if (!hasConversationHistory) return false;
    const normalized = content.trim().toLowerCase();
    if (normalized.length > 240) return false;
    return /\b(it|its|that|this|these|those|they|them|above|previous|same|again|more|shorter|longer|format|markdown|md|table|list|rewrite|rephrase|summari[sz]e|translate|explain)\b/.test(
      normalized,
    );
  }

  private hasLexicalSupport(query: string, content: string): boolean {
    const ignoredTerms = new Set([
      'about',
      'again',
      'could',
      'from',
      'give',
      'have',
      'into',
      'more',
      'please',
      'that',
      'their',
      'then',
      'this',
      'what',
      'when',
      'where',
      'which',
      'with',
      'would',
    ]);
    const queryTerms = this.tokenizeForLexicalMatch(query)
      .filter((term) => term.length >= 3 && !ignoredTerms.has(term))
      .map((term) => this.stemLexicalTerm(term));
    if (!queryTerms.length) return false;
    const contentTerms = new Set(
      this.tokenizeForLexicalMatch(content).map((term) =>
        this.stemLexicalTerm(term),
      ),
    );
    const matchedTerms = queryTerms.filter((term) => contentTerms.has(term));
    const requiredMatches = queryTerms.length <= 2 ? 1 : 2;
    return matchedTerms.length >= Math.min(requiredMatches, queryTerms.length);
  }

  private tokenizeForLexicalMatch(value: string): string[] {
    return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  }

  private stemLexicalTerm(term: string): string {
    if (term.length >= 7 && term.endsWith('ing')) return term.slice(0, -3);
    if (term.length >= 6 && term.endsWith('er')) return term.slice(0, -2);
    if (term.length >= 6 && term.endsWith('ed')) return term.slice(0, -2);
    if (term.length >= 6 && term.endsWith('es')) return term.slice(0, -2);
    if (term.length >= 5 && term.endsWith('s')) return term.slice(0, -1);
    return term;
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

  private toJsonArray(value: unknown): Prisma.InputJsonArray {
    return (Array.isArray(value) ? value : []) as Prisma.InputJsonArray;
  }

  private normalizeTemplateSendComponents(
    rawCategory: string,
    templateComponents: Record<string, unknown>[],
    input: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) {
      throw new BadRequestException('Template send components are too large');
    }
    const components = JSON.parse(serialized) as Record<string, unknown>[];
    const seen = new Set<string>();
    for (const component of components) {
      const type =
        typeof component.type === 'string'
          ? component.type.trim().toLowerCase()
          : '';
      if (!['header', 'body', 'button'].includes(type)) {
        throw new BadRequestException(
          `Unsupported template send component ${type}`,
        );
      }
      component.type = type;
      const parameters = Array.isArray(component.parameters)
        ? component.parameters
        : [];
      if (!parameters.length || parameters.length > 20) {
        throw new BadRequestException(
          `${type} must contain between one and twenty parameters`,
        );
      }
      parameters.forEach((parameter) =>
        this.validateTemplateSendParameter(parameter),
      );
      if (type === 'button') {
        const rawIndex = component.index;
        const index =
          typeof rawIndex === 'string' || typeof rawIndex === 'number'
            ? String(rawIndex)
            : '';
        const subType =
          typeof component.sub_type === 'string'
            ? component.sub_type.trim().toLowerCase()
            : '';
        if (!/^\d+$/.test(index)) {
          throw new BadRequestException(
            'Template button component requires a numeric index',
          );
        }
        if (!['url', 'quick_reply', 'flow', 'catalog'].includes(subType)) {
          throw new BadRequestException(
            `Unsupported template button parameter type ${subType}`,
          );
        }
        component.index = index;
        component.sub_type = subType;
        const key = `button:${index}:${subType}`;
        if (seen.has(key)) {
          throw new BadRequestException(
            'Template button parameters cannot be duplicated',
          );
        }
        seen.add(key);
      } else {
        if (seen.has(type)) {
          throw new BadRequestException(
            `Template send can contain only one ${type} component`,
          );
        }
        seen.add(type);
      }
    }

    const definitions: Record<string, unknown>[] = templateComponents.map(
      (component) => ({
        ...component,
        type:
          typeof component.type === 'string'
            ? component.type.trim().toUpperCase()
            : '',
      }),
    );
    const bodyDefinition = definitions.find(
      (component) => component.type === 'BODY',
    );
    const bodyCount =
      rawCategory.toUpperCase() === 'AUTHENTICATION'
        ? 1
        : this.templateVariableCount(
            typeof bodyDefinition?.text === 'string' ? bodyDefinition.text : '',
          );
    this.assertRuntimeParameterCount(components, 'body', bodyCount);

    const headerDefinition = definitions.find(
      (component) => component.type === 'HEADER',
    );
    const headerFormat =
      typeof headerDefinition?.format === 'string'
        ? headerDefinition.format.toUpperCase()
        : 'NONE';
    const headerCount =
      headerFormat === 'TEXT'
        ? this.templateVariableCount(
            typeof headerDefinition?.text === 'string'
              ? headerDefinition.text
              : '',
          )
        : ['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(headerFormat)
          ? 1
          : 0;
    const headerComponent = this.assertRuntimeParameterCount(
      components,
      'header',
      headerCount,
    );
    if (headerComponent && headerCount) {
      const parameters = headerComponent.parameters as Record<
        string,
        unknown
      >[];
      const expected = headerFormat === 'TEXT' ? 'TEXT' : headerFormat;
      if (
        parameters.some(
          (parameter) => String(parameter.type).toUpperCase() !== expected,
        )
      ) {
        throw new BadRequestException(
          `Template header requires a ${expected.toLowerCase()} parameter`,
        );
      }
    }

    const buttonsDefinition = definitions.find(
      (component) => component.type === 'BUTTONS',
    );
    const rawButtons = Array.isArray(buttonsDefinition?.buttons)
      ? buttonsDefinition.buttons
      : [];
    const expectedButtons = new Map<string, boolean>();
    rawButtons.forEach((rawButton, index) => {
      const button = this.asRecord(rawButton);
      const type =
        typeof button.type === 'string' ? button.type.toUpperCase() : '';
      let subType: string | null = null;
      let required = false;
      if (type === 'OTP') {
        subType = 'url';
        required = true;
      } else if (
        type === 'URL' &&
        typeof button.url === 'string' &&
        /\{\{1\}\}/.test(button.url)
      ) {
        subType = 'url';
        required = true;
      } else if (type === 'FLOW') {
        subType = 'flow';
        required = true;
      } else if (type === 'MPM') {
        subType = 'catalog';
        required = true;
      } else if (type === 'QUICK_REPLY') {
        subType = 'quick_reply';
      }
      if (subType) expectedButtons.set(`${index}:${subType}`, required);
    });
    const suppliedButtons = components.filter(
      (component) => component.type === 'button',
    );
    for (const component of suppliedButtons) {
      const key = `${String(component.index)}:${String(component.sub_type)}`;
      if (!expectedButtons.has(key)) {
        throw new BadRequestException(
          `Template does not define runtime button parameters for index ${String(component.index)}`,
        );
      }
      const parameters = component.parameters as Record<string, unknown>[];
      const subType = String(component.sub_type);
      const expectedParameterType =
        subType === 'quick_reply'
          ? 'payload'
          : subType === 'flow' || subType === 'catalog'
            ? 'action'
            : 'text';
      if (
        parameters.length !== 1 ||
        parameters[0].type !== expectedParameterType
      ) {
        throw new BadRequestException(
          `Template ${subType} button requires one ${expectedParameterType} parameter`,
        );
      }
      if (subType === 'flow') {
        const action = this.asRecord(parameters[0].action);
        if (
          typeof action.flow_token !== 'string' ||
          !action.flow_token.trim()
        ) {
          throw new BadRequestException(
            'Template Flow button requires a non-empty flow token',
          );
        }
      }
      if (subType === 'catalog') {
        const action = this.asRecord(parameters[0].action);
        if (
          typeof action.thumbnail_product_retailer_id !== 'string' ||
          !action.thumbnail_product_retailer_id.trim()
        ) {
          throw new BadRequestException(
            'Template catalog button requires a thumbnail product retailer ID',
          );
        }
      }
    }
    for (const [key, required] of expectedButtons) {
      if (
        required &&
        !suppliedButtons.some(
          (component) =>
            `${String(component.index)}:${String(component.sub_type)}` === key,
        )
      ) {
        throw new BadRequestException(
          `Template requires runtime parameters for button ${key.split(':')[0]}`,
        );
      }
    }
    components.forEach((component) => {
      if (component.type === 'button' && component.sub_type === 'catalog') {
        component.sub_type = 'CATALOG';
      }
    });
    return components;
  }

  private assertRuntimeParameterCount(
    components: Record<string, unknown>[],
    type: 'header' | 'body',
    expected: number,
  ) {
    const component = components.find((item) => item.type === type);
    const actual = component
      ? (component.parameters as Record<string, unknown>[]).length
      : 0;
    if (actual !== expected) {
      throw new BadRequestException(
        `Template ${type} requires exactly ${expected} runtime parameter${expected === 1 ? '' : 's'}`,
      );
    }
    return component;
  }

  private validateTemplateSendParameter(rawParameter: unknown) {
    const parameter = this.asRecord(rawParameter);
    const type =
      typeof parameter.type === 'string'
        ? parameter.type.trim().toLowerCase()
        : '';
    parameter.type = type;
    if (type === 'text') {
      if (
        typeof parameter.text !== 'string' ||
        !parameter.text.trim() ||
        parameter.text.length > 4096
      ) {
        throw new BadRequestException(
          'Template text parameters must be between 1 and 4096 characters',
        );
      }
      parameter.text = parameter.text.trim();
      return;
    }
    if (type === 'payload') {
      if (
        typeof parameter.payload !== 'string' ||
        !parameter.payload.trim() ||
        parameter.payload.length > 256
      ) {
        throw new BadRequestException(
          'Quick-reply payload must be between 1 and 256 characters',
        );
      }
      return;
    }
    if (['image', 'video', 'document'].includes(type)) {
      const media = this.asRecord(parameter[type]);
      const id = typeof media.id === 'string' ? media.id.trim() : '';
      const link = typeof media.link === 'string' ? media.link.trim() : '';
      if ((!id && !link) || (id && link)) {
        throw new BadRequestException(
          `Template ${type} parameter requires either a media ID or HTTPS link`,
        );
      }
      if (link) this.assertPublicHttpsUrl(link, `Template ${type} link`);
      return;
    }
    if (type === 'location') {
      const location = this.asRecord(parameter.location);
      const rawLatitude = location.latitude;
      const rawLongitude = location.longitude;
      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      if (
        (typeof rawLatitude !== 'number' &&
          (typeof rawLatitude !== 'string' || !rawLatitude.trim())) ||
        (typeof rawLongitude !== 'number' &&
          (typeof rawLongitude !== 'string' || !rawLongitude.trim())) ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180 ||
        typeof location.name !== 'string' ||
        !location.name.trim() ||
        typeof location.address !== 'string' ||
        !location.address.trim()
      ) {
        throw new BadRequestException(
          'Template location requires valid coordinates, name, and address',
        );
      }
      return;
    }
    if (type === 'action') {
      const action = this.asRecord(parameter.action);
      if (!Object.keys(action).length) {
        throw new BadRequestException('Template action cannot be empty');
      }
      if (Buffer.byteLength(JSON.stringify(action), 'utf8') > 8 * 1024) {
        throw new BadRequestException('Template action is too large');
      }
      return;
    }
    if (type === 'currency' || type === 'date_time') {
      if (!Object.keys(this.asRecord(parameter[type])).length) {
        throw new BadRequestException(`Template ${type} parameter is invalid`);
      }
      return;
    }
    throw new BadRequestException(`Unsupported template parameter ${type}`);
  }

  private templateVariableCount(text: string) {
    return new Set(
      [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
    ).size;
  }

  private assertPublicHttpsUrl(value: string, label: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException(`${label} is invalid`);
    }
    if (url.protocol !== 'https:' || !url.hostname) {
      throw new BadRequestException(`${label} must use HTTPS`);
    }
  }

  private normalizeTemplateComponents(
    rawCategory: string,
    input: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (!input.length) {
      throw new BadRequestException('A template body is required');
    }
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
      throw new BadRequestException('Template components are too large');
    }
    const category = rawCategory.trim().toUpperCase();
    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
      throw new BadRequestException(
        `Unsupported template category ${category}`,
      );
    }
    const components = JSON.parse(serialized) as Record<string, unknown>[];
    const seen = new Set<string>();
    for (const component of components) {
      const type =
        typeof component.type === 'string'
          ? component.type.trim().toUpperCase()
          : '';
      if (!['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(type)) {
        throw new BadRequestException(`Unsupported template component ${type}`);
      }
      if (seen.has(type)) {
        throw new BadRequestException(`Template can contain only one ${type}`);
      }
      seen.add(type);
      component.type = type;

      if (type === 'BUTTONS') {
        this.validateTemplateButtons(category, component.buttons);
        continue;
      }

      if (category === 'AUTHENTICATION') {
        this.normalizeAuthenticationComponent(type, component);
        continue;
      }

      if (type === 'HEADER') {
        this.normalizeStandardHeader(component);
        continue;
      }

      const text =
        typeof component.text === 'string' ? component.text.trim() : '';
      if (!text) {
        throw new BadRequestException(`${type} text cannot be empty`);
      }
      const maxLength = type === 'BODY' ? 1024 : 60;
      if (text.length > maxLength) {
        throw new BadRequestException(
          `${type} text cannot exceed ${maxLength} characters`,
        );
      }
      component.text = text;
      this.validateTemplateVariables(type, text, component.example);
    }
    if (!seen.has('BODY')) {
      throw new BadRequestException('A template body is required');
    }
    if (category === 'AUTHENTICATION' && !seen.has('BUTTONS')) {
      throw new BadRequestException(
        'Authentication templates require one OTP button',
      );
    }
    return components;
  }

  private assertTemplateMediaSignature(mimeType: string, buffer: Buffer) {
    const matches =
      (mimeType === 'image/jpeg' &&
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff) ||
      (mimeType === 'image/png' &&
        buffer.length >= 8 &&
        buffer
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )) ||
      (mimeType === 'application/pdf' &&
        buffer.length >= 5 &&
        buffer.subarray(0, 5).toString('ascii') === '%PDF-') ||
      (mimeType === 'video/mp4' &&
        buffer.length >= 12 &&
        buffer.subarray(4, 8).toString('ascii') === 'ftyp');
    if (!matches) {
      throw new BadRequestException(
        'Template media content does not match its declared file type',
      );
    }
  }

  private normalizeStandardHeader(component: Record<string, unknown>) {
    const format =
      typeof component.format === 'string'
        ? component.format.trim().toUpperCase()
        : 'TEXT';
    if (!['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(format)) {
      throw new BadRequestException(`Unsupported template header ${format}`);
    }
    component.format = format;
    if (format === 'LOCATION') {
      delete component.text;
      delete component.example;
      return;
    }
    if (format !== 'TEXT') {
      const example = this.asRecord(component.example);
      const handles = Array.isArray(example.header_handle)
        ? example.header_handle
        : [];
      if (
        handles.length !== 1 ||
        typeof handles[0] !== 'string' ||
        !handles[0].trim()
      ) {
        throw new BadRequestException(
          `${format} headers require one Meta sample media handle`,
        );
      }
      component.example = { header_handle: [handles[0].trim()] };
      delete component.text;
      return;
    }
    const text =
      typeof component.text === 'string' ? component.text.trim() : '';
    if (!text || text.length > 60) {
      throw new BadRequestException(
        'TEXT header text is required and cannot exceed 60 characters',
      );
    }
    component.text = text;
    this.validateTemplateVariables('HEADER', text, component.example, 1);
  }

  private normalizeAuthenticationComponent(
    type: string,
    component: Record<string, unknown>,
  ) {
    if (type === 'HEADER') {
      throw new BadRequestException(
        'Authentication templates cannot contain a header',
      );
    }
    if (type === 'BODY') {
      if (typeof component.add_security_recommendation !== 'boolean') {
        throw new BadRequestException(
          'Authentication template body requires add_security_recommendation',
        );
      }
      delete component.text;
      delete component.example;
      return;
    }
    if (type === 'FOOTER') {
      const minutes = component.code_expiration_minutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > 90
      ) {
        throw new BadRequestException(
          'Authentication code expiration must be an integer from 1 to 90 minutes',
        );
      }
      delete component.text;
    }
  }

  private validateTemplateVariables(
    type: string,
    text: string,
    rawExample: unknown,
    maximum?: number,
  ) {
    const matches = [...text.matchAll(/\{\{(\d+)\}\}/g)];
    const stripped = text.replace(/\{\{\d+\}\}/g, '');
    if (stripped.includes('{{') || stripped.includes('}}')) {
      throw new BadRequestException(
        `${type} contains an invalid variable; use {{1}}, {{2}}, and so on`,
      );
    }
    const indexes = [...new Set(matches.map((match) => Number(match[1])))];
    if (!indexes.length) return;
    if (maximum !== undefined && indexes.length > maximum) {
      throw new BadRequestException(
        `${type} can contain at most ${maximum} variable`,
      );
    }
    if (indexes.some((value, index) => value !== index + 1)) {
      throw new BadRequestException(
        `${type} variables must be sequential, beginning with {{1}}`,
      );
    }
    const example =
      rawExample && !Array.isArray(rawExample) && typeof rawExample === 'object'
        ? (rawExample as Record<string, unknown>)
        : {};
    const values =
      type === 'BODY'
        ? Array.isArray(example.body_text) &&
          Array.isArray(example.body_text[0])
          ? example.body_text[0]
          : []
        : Array.isArray(example.header_text)
          ? example.header_text
          : [];
    if (
      values.length !== indexes.length ||
      values.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new BadRequestException(
        `${type} requires one non-empty example value for every variable`,
      );
    }
  }

  private validateTemplateButtons(category: string, rawButtons: unknown) {
    if (
      !Array.isArray(rawButtons) ||
      !rawButtons.length ||
      rawButtons.length > 3
    ) {
      throw new BadRequestException(
        'Templates can contain between one and three buttons',
      );
    }
    if (category === 'AUTHENTICATION' && rawButtons.length !== 1) {
      throw new BadRequestException(
        'Authentication templates require exactly one OTP button',
      );
    }
    let phoneButtons = 0;
    let flowButtons = 0;
    for (const rawButton of rawButtons) {
      if (
        !rawButton ||
        Array.isArray(rawButton) ||
        typeof rawButton !== 'object'
      ) {
        throw new BadRequestException('Template button is invalid');
      }
      const button = rawButton as Record<string, unknown>;
      const type =
        typeof button.type === 'string' ? button.type.toUpperCase() : '';
      if (
        !['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'OTP', 'FLOW', 'MPM'].includes(
          type,
        )
      ) {
        throw new BadRequestException(`Unsupported template button ${type}`);
      }
      if (
        typeof button.text !== 'string' ||
        !button.text.trim() ||
        button.text.trim().length > 25
      ) {
        throw new BadRequestException(
          'Each template button needs text of at most 25 characters',
        );
      }
      button.type = type;
      button.text = button.text.trim();
      if (category === 'AUTHENTICATION') {
        if (type !== 'OTP') {
          throw new BadRequestException(
            'Authentication templates support only an OTP button',
          );
        }
        this.normalizeOtpButton(button);
        continue;
      }
      if (type === 'OTP') {
        throw new BadRequestException(
          'OTP buttons are available only for authentication templates',
        );
      }
      if (type === 'MPM' && category !== 'MARKETING') {
        throw new BadRequestException(
          'Product catalog buttons are available only for marketing templates',
        );
      }
      if (type === 'URL') {
        if (
          typeof button.url !== 'string' ||
          !button.url.startsWith('https://')
        ) {
          throw new BadRequestException('Template button URLs must use HTTPS');
        }
        const variables = [...button.url.matchAll(/\{\{(\d+)\}\}/g)];
        const stripped = button.url.replace(/\{\{\d+\}\}/g, '');
        if (
          stripped.includes('{{') ||
          stripped.includes('}}') ||
          variables.length > 1 ||
          (variables.length === 1 && variables[0][1] !== '1')
        ) {
          throw new BadRequestException(
            'Dynamic button URLs can contain only one {{1}} variable',
          );
        }
        if (variables.length) {
          const examples = Array.isArray(button.example) ? button.example : [];
          if (
            examples.length !== 1 ||
            typeof examples[0] !== 'string' ||
            !examples[0].trim()
          ) {
            throw new BadRequestException(
              'Dynamic button URLs require one non-empty example value',
            );
          }
          button.example = [examples[0].trim()];
        } else {
          delete button.example;
        }
      }
      if (
        type === 'PHONE_NUMBER' &&
        (typeof button.phone_number !== 'string' ||
          !/^\+[1-9]\d{7,14}$/.test(button.phone_number))
      ) {
        throw new BadRequestException(
          'Template phone buttons require an E.164 phone number',
        );
      }
      if (type === 'PHONE_NUMBER') phoneButtons += 1;
      if (type === 'FLOW') {
        flowButtons += 1;
        if (
          typeof button.flow_id !== 'string' ||
          !/^\d+$/.test(button.flow_id.trim())
        ) {
          throw new BadRequestException(
            'Flow buttons require a numeric Meta Flow ID',
          );
        }
        button.flow_id = button.flow_id.trim();
        button.flow_action =
          button.flow_action === 'data_exchange' ? 'data_exchange' : 'navigate';
        if (
          button.navigate_screen !== undefined &&
          (typeof button.navigate_screen !== 'string' ||
            !button.navigate_screen.trim())
        ) {
          throw new BadRequestException(
            'Flow navigate screen cannot be empty when provided',
          );
        }
      }
    }
    if (phoneButtons > 1) {
      throw new BadRequestException(
        'A template can contain at most one phone number button',
      );
    }
    if (flowButtons > 1) {
      throw new BadRequestException(
        'A template can contain at most one Flow button',
      );
    }
  }

  private normalizeOtpButton(button: Record<string, unknown>) {
    const otpType =
      typeof button.otp_type === 'string'
        ? button.otp_type.trim().toUpperCase()
        : '';
    if (!['COPY_CODE', 'ONE_TAP'].includes(otpType)) {
      throw new BadRequestException(
        'Authentication OTP type must be COPY_CODE or ONE_TAP',
      );
    }
    button.otp_type = otpType;
    if (otpType === 'ONE_TAP') {
      for (const field of ['autofill_text', 'package_name', 'signature_hash']) {
        if (typeof button[field] !== 'string' || !button[field].trim()) {
          throw new BadRequestException(
            `ONE_TAP authentication requires ${field}`,
          );
        }
        button[field] = button[field].trim();
      }
      if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(String(button.package_name))) {
        throw new BadRequestException('Android package name is invalid');
      }
    } else {
      delete button.autofill_text;
      delete button.package_name;
      delete button.signature_hash;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && !Array.isArray(value) && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
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
