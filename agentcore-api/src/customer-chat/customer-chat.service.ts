import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ChatService, type ChatHistoryMessage } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { AppointmentBookingService } from '../appointment-booking/appointment-booking.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import {
  KnowledgeSearchRow,
  KnowledgeService,
} from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import {
  AssignCustomerChatConversationDto,
  CustomerChatConversationStatusDto,
  ListCustomerChatConversationsDto,
  SendAgentCustomerChatMessageDto,
  UpdateCustomerChatConversationStatusDto,
} from './dto/agent-inbox.dto';
import { CreateCustomerChatConversationDto } from './dto/create-conversation.dto';
import {
  CreatePublicCustomerChatConversationDto,
  SendPublicCustomerChatMessageDto,
} from './dto/public-widget.dto';
import { SendCustomerChatMessageDto } from './dto/send-message.dto';
import {
  CreateCustomerChatWidgetConfigDto,
  UpdateCustomerChatWidgetConfigDto,
} from './dto/update-widget-config.dto';
import { ListCustomerChatWidgetConfigsDto } from './dto/list-widget-configs.dto';
import { ListCustomerChatMessagesDto } from './dto/list-messages.dto';
import { CustomerChatRealtimeService } from './customer-chat-realtime.service';

type WidgetConfigWithFolders = Prisma.CustomerChatWidgetConfigGetPayload<{
  include: { folderScopes: true };
}>;

type ConversationWithMessages = Prisma.CustomerChatConversationGetPayload<{
  include: {
    messages: {
      include: {
        citations: {
          include: {
            chunk: true;
          };
        };
      };
    };
    widgetConfig: {
      include: { folderScopes: true };
    };
  };
}>;

type ConversationContext = Prisma.CustomerChatConversationGetPayload<{
  include: {
    widgetConfig: {
      include: { folderScopes: true };
    };
  };
}>;

type MessageWithCitations = Prisma.CustomerChatMessageGetPayload<{
  include: { citations: { include: { chunk: true } } };
}>;

type WidgetMemoryPolicy = {
  enabled: boolean;
  recentMessageLimit: number;
  lowConfidenceAction: 'clarify' | 'handoff';
  maxClarificationAttempts: number;
};

export type CustomerChatStreamCallbacks = {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
  onReplace?: (content: string) => void | Promise<void>;
};

@Injectable()
export class CustomerChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerChatService.name);
  private retentionTimer?: NodeJS.Timeout;

  constructor(
    private readonly auditService: AuditService,
    private readonly appointmentBookingService: AppointmentBookingService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly knowledgeService: KnowledgeService,
    private readonly prisma: PrismaService,
    private readonly rateLimitService: RateLimitService,
    private readonly realtimeService: CustomerChatRealtimeService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.get<number>(
      'CUSTOMER_CHAT_RETENTION_SWEEP_INTERVAL_MS',
      60 * 60 * 1000,
    );
    this.retentionTimer = setInterval(() => {
      void this.purgeExpiredConversations();
    }, intervalMs);
    this.retentionTimer.unref();
    void this.purgeExpiredConversations();
  }

  onModuleDestroy() {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }

  async createConversation(
    currentUser: AuthenticatedUser,
    input: CreateCustomerChatConversationDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCustomerChatEnabled(organizationId);

    const conversation = await this.prisma.customerChatConversation.create({
      data: {
        organizationId,
        visitorId: input.visitorId,
        visitorName: input.visitorName,
        visitorEmail: input.visitorEmail,
        expiresAt: this.addDays(
          new Date(),
          this.configService.get<number>('CUSTOMER_CHAT_RETENTION_DAYS', 90),
        ),
        metadata: this.toJsonObject(input.metadata),
      },
      include: this.conversationInclude(),
    });

    await this.publishConversationEvent(conversation, 'conversation.created');
    return this.toConversationResponse(conversation);
  }

  async getConversation(currentUser: AuthenticatedUser, id: string) {
    const conversation = await this.findConversationForActor(currentUser, id);
    return this.toConversationResponse(conversation);
  }

  async listConversations(
    currentUser: AuthenticatedUser,
    input: ListCustomerChatConversationsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCustomerChatEnabled(organizationId);

    const where: Prisma.CustomerChatConversationWhereInput = {
      organizationId,
      status: input.status,
      assignedAgentId: input.assignedAgentId,
    };

    if (input.search) {
      where.OR = [
        { visitorId: { contains: input.search, mode: 'insensitive' } },
        { visitorName: { contains: input.search, mode: 'insensitive' } },
        { visitorEmail: { contains: input.search, mode: 'insensitive' } },
      ];
    }

    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const [total, conversations] = await this.prisma.$transaction([
      this.prisma.customerChatConversation.count({ where }),
      this.prisma.customerChatConversation.findMany({
        where,
        include: this.conversationInclude(1),
        orderBy: { updatedAt: 'desc' },
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

  async sendMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendCustomerChatMessageDto,
  ) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      id,
    );
    await this.assertCustomerChatEnabled(conversation.organizationId);
    return this.processVisitorMessage(currentUser, conversation, input, false);
  }

  async listMessages(
    currentUser: AuthenticatedUser,
    conversationId: string,
    input: ListCustomerChatMessagesDto,
  ) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      conversationId,
    );
    return this.loadMessagePage(conversation.id, input, false);
  }

  async requestHandoff(currentUser: AuthenticatedUser, id: string) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      id,
    );
    const updatedConversation = await this.markConversationWaiting(
      conversation.id,
      conversation.organizationId,
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'customer_chat.handoff_requested',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
    });

    await this.publishConversationEvent(
      updatedConversation,
      'handoff.requested',
    );

    return this.toConversationResponse(updatedConversation);
  }

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendAgentCustomerChatMessageDto,
  ) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      id,
    );
    await this.assertCustomerChatEnabled(conversation.organizationId);
    if (
      conversation.assignedAgentId &&
      conversation.assignedAgentId !== currentUser.sub &&
      !currentUser.roles.some((role) =>
        ['super_admin', 'org_admin', 'product_admin'].includes(role),
      )
    ) {
      throw new ForbiddenException(
        'This conversation is assigned to another agent',
      );
    }

    const now = new Date();
    const { agentMessage, updatedConversation } =
      await this.prisma.$transaction(async (transaction) => {
        const claimed = await transaction.customerChatConversation.updateMany({
          where: { id: conversation.id, version: conversation.version },
          data: {
            status: 'open',
            assignedAgentId: conversation.assignedAgentId ?? currentUser.sub,
            lastMessageAt: now,
            version: { increment: 1 },
          },
        });
        if (claimed.count === 0) {
          throw this.conversationConflict();
        }
        const message = await transaction.customerChatMessage.create({
          data: {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            role: 'agent',
            content: input.content,
            metadata: this.toJsonObject({
              agentId: currentUser.sub,
              agentEmail: currentUser.email,
            }),
          },
          include: { citations: { include: { chunk: true } } },
        });
        const updated = await transaction.customerChatConversation.findUnique({
          where: { id: conversation.id },
          include: this.conversationInclude(),
        });
        if (!updated) {
          throw new NotFoundException('Customer chat conversation not found');
        }
        return { agentMessage: message, updatedConversation: updated };
      });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'customer_chat.agent_replied',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
      metadata: {
        messageId: agentMessage.id,
      },
    });

    await this.publishConversationEvent(updatedConversation, 'message.created');

    return {
      conversation: this.toConversationResponse(updatedConversation),
      agentMessage: this.toMessageResponse(agentMessage),
    };
  }

  async assignConversation(
    currentUser: AuthenticatedUser,
    id: string,
    input: AssignCustomerChatConversationDto,
  ) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      id,
    );
    const assignedAgentId = input.assignedAgentId ?? null;

    if (assignedAgentId) {
      await this.assertAssignableAgent(
        conversation.organizationId,
        assignedAgentId,
      );
    }

    const expectedVersion = input.expectedVersion ?? conversation.version;
    const updatedConversation = await this.prisma.$transaction(
      async (transaction) => {
        const changed = await transaction.customerChatConversation.updateMany({
          where: { id: conversation.id, version: expectedVersion },
          data: { assignedAgentId, version: { increment: 1 } },
        });
        if (changed.count === 0) {
          throw this.conversationConflict();
        }
        const updated = await transaction.customerChatConversation.findUnique({
          where: { id: conversation.id },
          include: this.conversationInclude(),
        });
        if (!updated) {
          throw new NotFoundException('Customer chat conversation not found');
        }
        return updated;
      },
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'customer_chat.conversation_assigned',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
      metadata: {
        assignedAgentId,
      },
    });

    await this.publishConversationEvent(
      updatedConversation,
      'conversation.updated',
    );

    return this.toConversationResponse(updatedConversation);
  }

  async updateConversationStatus(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateCustomerChatConversationStatusDto,
  ) {
    const conversation = await this.findConversationContextForActor(
      currentUser,
      id,
    );

    const expectedVersion = input.expectedVersion ?? conversation.version;
    const updatedConversation = await this.prisma.$transaction(
      async (transaction) => {
        const changed = await transaction.customerChatConversation.updateMany({
          where: { id: conversation.id, version: expectedVersion },
          data: {
            status: input.status,
            handoffRequestedAt:
              input.status ===
              CustomerChatConversationStatusDto.waiting_for_agent
                ? (conversation.handoffRequestedAt ?? new Date())
                : conversation.handoffRequestedAt,
            version: { increment: 1 },
          },
        });
        if (changed.count === 0) {
          throw this.conversationConflict();
        }
        const updated = await transaction.customerChatConversation.findUnique({
          where: { id: conversation.id },
          include: this.conversationInclude(),
        });
        if (!updated) {
          throw new NotFoundException('Customer chat conversation not found');
        }
        return updated;
      },
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'customer_chat.status_updated',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
      metadata: {
        status: input.status,
      },
    });

    await this.publishConversationEvent(
      updatedConversation,
      'conversation.updated',
    );

    return this.toConversationResponse(updatedConversation);
  }

  async getWidgetConfig(currentUser: AuthenticatedUser) {
    const config = await this.ensureWidgetConfig(currentUser.orgId);
    return this.toWidgetConfigResponse(config);
  }

  async updateWidgetConfig(
    currentUser: AuthenticatedUser,
    input: UpdateCustomerChatWidgetConfigDto,
  ) {
    const existing = await this.ensureWidgetConfig(currentUser.orgId);
    return this.updateWidgetConfigById(currentUser, existing.id, input);
  }

  async listWidgetConfigs(
    currentUser: AuthenticatedUser,
    input: ListCustomerChatWidgetConfigsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCustomerChatEnabled(organizationId);
    const page = input.page ?? 1;
    const limit = input.limit ?? 10;
    const [configs, total] = await Promise.all([
      this.prisma.customerChatWidgetConfig.findMany({
        where: { organizationId },
        include: { folderScopes: true },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.customerChatWidgetConfig.count({ where: { organizationId } }),
    ]);

    return {
      data: configs.map((config) => this.toWidgetConfigResponse(config)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async createWidgetConfig(
    currentUser: AuthenticatedUser,
    input: CreateCustomerChatWidgetConfigDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCustomerChatEnabled(organizationId);
    const knowledgeScope = input.knowledgeScope ?? 'all';
    const folderIds =
      knowledgeScope === 'folders' ? (input.folderIds ?? []) : [];
    await this.assertWidgetFolders(organizationId, knowledgeScope, folderIds);
    this.assertAllowedDomainsForWidget(input.allowedDomains ?? []);

    const config = await this.prisma.customerChatWidgetConfig.create({
      data: {
        organizationId,
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        knowledgeScope,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
        settings: this.toJsonObject(
          this.normalizeWidgetSettings(input.settings),
        ),
        folderScopes: {
          create: folderIds.map((folderId) => ({ folderId })),
        },
      },
      include: { folderScopes: true },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'customer_chat.widget_config_created',
      entityType: 'customer_chat_widget_config',
      entityId: config.id,
      metadata: { name: config.name, knowledgeScope, folderIds },
    });

    return this.toWidgetConfigResponse(config);
  }

  async getWidgetConfigById(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findWidgetConfigForActor(currentUser, id);
    return this.toWidgetConfigResponse(config);
  }

  async updateWidgetConfigById(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateCustomerChatWidgetConfigDto,
  ) {
    const existing = await this.findWidgetConfigForActor(currentUser, id);
    if (
      input.organizationId &&
      input.organizationId !== existing.organizationId
    ) {
      throw new BadRequestException(
        'A widget cannot be moved to another organization',
      );
    }

    const knowledgeScope =
      input.knowledgeScope ??
      (existing.knowledgeScope === 'folders' ? 'folders' : 'all');
    const existingFolderIds = existing.folderScopes.map(
      (scope) => scope.folderId,
    );
    const folderIds =
      knowledgeScope === 'folders'
        ? (input.folderIds ?? existingFolderIds)
        : [];
    await this.assertWidgetFolders(
      existing.organizationId,
      knowledgeScope,
      folderIds,
    );
    if (input.allowedDomains !== undefined) {
      this.assertAllowedDomainsForWidget(input.allowedDomains);
    }

    const replaceFolderScopes =
      input.knowledgeScope !== undefined || input.folderIds !== undefined;
    const config = await this.prisma.customerChatWidgetConfig.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        enabled: input.enabled,
        knowledgeScope,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
        settings: input.settings
          ? this.toJsonObject(
              this.normalizeWidgetSettings(
                input.settings,
                this.toRecord(existing.settings),
              ),
            )
          : undefined,
        folderScopes: replaceFolderScopes
          ? {
              deleteMany: {},
              create: folderIds.map((folderId) => ({ folderId })),
            }
          : undefined,
      },
      include: { folderScopes: true },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'customer_chat.widget_config_updated',
      entityType: 'customer_chat_widget_config',
      entityId: config.id,
      metadata: this.removeUndefined({
        enabled: input.enabled,
        name: input.name,
        knowledgeScope,
        folderIds,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
      }),
    });

    return this.toWidgetConfigResponse(config);
  }

  async deleteWidgetConfig(currentUser: AuthenticatedUser, id: string) {
    const config = await this.findWidgetConfigForActor(currentUser, id);
    await this.prisma.customerChatWidgetConfig.delete({ where: { id } });
    await this.auditService.record({
      actor: currentUser,
      organizationId: config.organizationId,
      action: 'customer_chat.widget_config_deleted',
      entityType: 'customer_chat_widget_config',
      entityId: id,
      metadata: { name: config.name },
    });
    return { deleted: true };
  }

  async getPublicWidgetConfig(widgetKey: string, origin?: string) {
    const config = await this.findEnabledWidgetConfig(widgetKey);
    this.assertOriginAllowed(config.allowedDomains, origin);
    await this.assertCustomerChatEnabled(config.organizationId);

    return this.toPublicWidgetConfigResponse(config);
  }

  async createPublicConversation(
    widgetKey: string,
    input: CreatePublicCustomerChatConversationDto,
    origin?: string,
  ) {
    const config = await this.findEnabledWidgetConfig(widgetKey);
    this.assertOriginAllowed(config.allowedDomains, origin);
    await this.assertCustomerChatEnabled(config.organizationId);

    const visitorToken = this.createVisitorToken();
    const now = new Date();
    const conversation = await this.prisma.customerChatConversation.create({
      data: {
        organizationId: config.organizationId,
        widgetConfigId: config.id,
        visitorId: input.visitorId,
        visitorName: input.visitorName,
        visitorEmail: input.visitorEmail,
        visitorTokenHash: this.hashVisitorToken(visitorToken),
        visitorTokenExpiresAt: this.addHours(
          now,
          this.configService.get<number>(
            'CUSTOMER_CHAT_VISITOR_SESSION_HOURS',
            24,
          ),
        ),
        lastMessageAt: now,
        expiresAt: this.addDays(
          now,
          this.configService.get<number>('CUSTOMER_CHAT_RETENTION_DAYS', 90),
        ),
        metadata: this.toJsonObject(input.metadata),
      },
      include: this.conversationInclude(),
    });

    await this.publishConversationEvent(conversation, 'conversation.created');
    return {
      conversation: this.toConversationResponse(conversation, 'public'),
      visitorToken,
    };
  }

  async getPublicConversation(
    conversationId: string,
    visitorToken?: string,
    origin?: string,
  ) {
    const conversation = await this.findConversationForVisitor(
      conversationId,
      visitorToken,
      origin,
    );

    return this.toConversationResponse(conversation, 'public');
  }

  async sendPublicMessage(
    conversationId: string,
    input: SendPublicCustomerChatMessageDto,
    visitorToken?: string,
    origin?: string,
  ) {
    this.assertPublicMessageLength(input.content);

    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    await this.limitPublicConversationMessages(conversation.id);

    const publicUser = this.createSystemUser(conversation.organizationId);

    return this.processVisitorMessage(publicUser, conversation, input, true);
  }

  async sendPublicMessageStreaming(
    conversationId: string,
    input: SendPublicCustomerChatMessageDto,
    visitorToken: string | undefined,
    origin: string | undefined,
    callbacks: CustomerChatStreamCallbacks,
  ) {
    this.assertPublicMessageLength(input.content);
    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    await this.limitPublicConversationMessages(conversation.id);
    return this.processVisitorMessage(
      this.createSystemUser(conversation.organizationId),
      conversation,
      input,
      true,
      callbacks,
    );
  }

  async authorizePublicSocket(
    conversationId: string,
    visitorToken?: string,
    origin?: string,
  ) {
    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    return {
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
    };
  }

  async listPublicMessages(
    conversationId: string,
    input: ListCustomerChatMessagesDto,
    visitorToken?: string,
    origin?: string,
  ) {
    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    return this.loadMessagePage(conversation.id, input, true);
  }

  async requestPublicHandoff(
    conversationId: string,
    visitorToken?: string,
    origin?: string,
  ) {
    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    const updatedConversation = await this.markConversationWaiting(
      conversation.id,
      conversation.organizationId,
    );
    await this.auditService.record({
      actor: this.createSystemUser(conversation.organizationId),
      organizationId: conversation.organizationId,
      action: 'customer_chat.handoff_requested',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
      metadata: { source: 'public_widget' },
    });
    await this.publishConversationEvent(
      updatedConversation,
      'handoff.requested',
    );
    return this.toConversationResponse(updatedConversation, 'public');
  }

  async streamConversationForActor(
    currentUser: AuthenticatedUser,
    conversationId: string,
  ) {
    await this.findConversationContextForActor(currentUser, conversationId);
    return this.realtimeService.streamConversation(conversationId);
  }

  streamInboxForActor(currentUser: AuthenticatedUser, organizationId?: string) {
    return this.realtimeService.streamOrganization(
      this.resolveOrganizationId(currentUser, organizationId),
    );
  }

  async streamConversationForVisitor(
    conversationId: string,
    visitorToken?: string,
    origin?: string,
  ) {
    await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    return this.realtimeService.streamPublicConversation(conversationId);
  }

  private async processVisitorMessage(
    currentUser: AuthenticatedUser,
    conversation: ConversationContext,
    input: SendCustomerChatMessageDto,
    publicResponse: boolean,
    callbacks: CustomerChatStreamCallbacks = {},
  ) {
    this.throwIfAborted(callbacks.signal);
    const now = new Date();
    const { visitorMessage, canAutoReply, duplicate } =
      await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.customerChatConversation.findUnique({
          where: { id: conversation.id },
          select: { status: true, assignedAgentId: true },
        });
        if (!current) {
          throw new NotFoundException('Customer chat conversation not found');
        }
        if (input.clientMessageId) {
          const existing = await transaction.customerChatMessage.findUnique({
            where: {
              conversationId_clientMessageId: {
                conversationId: conversation.id,
                clientMessageId: input.clientMessageId,
              },
            },
            include: { citations: { include: { chunk: true } } },
          });
          if (existing) {
            return {
              visitorMessage: existing,
              canAutoReply: false,
              duplicate: true,
            };
          }
        }
        const message = await transaction.customerChatMessage.create({
          data: {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            clientMessageId: input.clientMessageId,
            role: 'visitor',
            content: input.content,
          },
          include: { citations: { include: { chunk: true } } },
        });
        await transaction.customerChatConversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: now,
            version: { increment: 1 },
            expiresAt: this.addDays(
              now,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
          },
        });
        return {
          visitorMessage: message,
          canAutoReply:
            current.status === 'open' && current.assignedAgentId === null,
          duplicate: false,
        };
      });

    if (duplicate) {
      const updatedConversation = await this.loadConversation(conversation.id);
      return {
        conversation: this.toConversationResponse(
          updatedConversation,
          publicResponse ? 'public' : 'internal',
        ),
        visitorMessage: this.toMessageResponse(
          visitorMessage,
          undefined,
          publicResponse,
        ),
        assistantMessage: null,
      };
    }

    try {
      await this.realtimeService.publish({
        type: 'message.created',
        conversationId: conversation.id,
        organizationId: conversation.organizationId,
      });
    } catch (error) {
      this.logger.warn(
        `Could not publish visitor message event for conversation ${conversation.id}: ${this.toErrorMessage(error)}`,
      );
    }

    if (!canAutoReply) {
      const updatedConversation = await this.loadConversation(conversation.id);
      return {
        conversation: this.toConversationResponse(
          updatedConversation,
          publicResponse ? 'public' : 'internal',
        ),
        visitorMessage: this.toMessageResponse(
          visitorMessage,
          undefined,
          publicResponse,
        ),
        assistantMessage: null,
      };
    }

    let answer: string;
    let metadata: Record<string, unknown>;
    let searchResults: KnowledgeSearchRow[] = [];
    let shouldAutoHandoff = false;
    const memoryPolicy = this.readWidgetMemoryPolicy(
      conversation.widgetConfig?.settings,
    );
    const conversationMemory = this.readConversationMemory(
      conversation.metadata,
    );
    let activeTopicQuery = conversationMemory.activeTopicQuery;
    let clarificationAttempts = 0;
    let clarificationRequested = false;
    let streamedAnswer = false;

    try {
      this.throwIfAborted(callbacks.signal);
      if (input.appointmentAction) {
        const result = await this.appointmentBookingService.executeAction(
          conversation.organizationId,
          input.appointmentAction,
        );
        answer = this.appointmentBookingService.formatActionResult(result);
        metadata = { appointmentAction: input.appointmentAction };
      } else {
        const conversationalResult = this.chatService.answerConversationally(
          input.content,
        );
        if (conversationalResult) {
          answer = conversationalResult.answer;
          metadata = {
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
            ? await this.prisma.customerChatMessage.findMany({
                where: {
                  conversationId: conversation.id,
                  organizationId: conversation.organizationId,
                  id: { not: visitorMessage.id },
                  role: { in: ['visitor', 'assistant'] },
                },
                select: { role: true, content: true, metadata: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: memoryPolicy.recentMessageLimit,
              })
            : [];
          const conversationHistory: ChatHistoryMessage[] = [...recentMessages]
            .reverse()
            .map((message) => ({
              role: message.role === 'visitor' ? 'user' : 'assistant',
              content: message.content,
            }));
          const previousVisitorMessage = [...conversationHistory]
            .reverse()
            .find((message) => message.role === 'user');
          const isContextualFollowUp = this.isContextualFollowUp(
            input.content,
            conversationHistory.length > 0,
          );
          const storedRetrievalTopic = recentMessages.find((message) => {
            if (message.role !== 'assistant') return false;
            const retrieval = this.toRecord(message.metadata).retrieval;
            return (
              retrieval &&
              !Array.isArray(retrieval) &&
              typeof retrieval === 'object' &&
              typeof (retrieval as Record<string, unknown>).topicQuery ===
                'string'
            );
          });
          const storedRetrieval = storedRetrievalTopic
            ? this.toRecord(storedRetrievalTopic.metadata).retrieval
            : null;
          const persistedTopicQuery =
            activeTopicQuery ??
            (storedRetrieval &&
            !Array.isArray(storedRetrieval) &&
            typeof storedRetrieval === 'object'
              ? (storedRetrieval as Record<string, unknown>).topicQuery
              : null);
          const inferredTopicMessage = [...conversationHistory]
            .reverse()
            .find(
              (message) =>
                message.role === 'user' &&
                !this.isContextualFollowUp(message.content, true) &&
                !this.chatService.answerConversationally(message.content),
            );
          const topicQuery =
            typeof persistedTopicQuery === 'string'
              ? persistedTopicQuery
              : (inferredTopicMessage?.content ??
                previousVisitorMessage?.content ??
                input.content);
          const searchUser: AuthenticatedUser = {
            ...currentUser,
            orgId: conversation.organizationId,
          };
          const retrievalQuery = isContextualFollowUp
            ? `${topicQuery}\nFollow-up request: ${input.content}`
            : input.content;
          const proposedTopicQuery = isContextualFollowUp
            ? topicQuery
            : input.content;
          const candidates = await this.knowledgeService.search(searchUser, {
            query: retrievalQuery,
            limit: 10,
            productKey: 'customer_chat',
            folderIds:
              conversation.widgetConfig?.knowledgeScope === 'folders'
                ? conversation.widgetConfig.folderScopes.map(
                    (scope) => scope.folderId,
                  )
                : undefined,
          });
          const minimumScore = this.configService.get<number>(
            'CUSTOMER_CHAT_MIN_SIMILARITY_SCORE',
            0.35,
          );
          const lexicalRescueMargin = this.configService.get<number>(
            'CUSTOMER_CHAT_LEXICAL_RESCUE_MARGIN',
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
          const lexicalRescueCount = searchResults.filter(
            (result) => result.score < minimumScore,
          ).length;
          const retrievalMetadata = {
            candidateCount: candidates.length,
            acceptedCount: searchResults.length,
            minimumScore,
            lexicalRescueMargin,
            lexicalRescueCount,
            topScore: candidates[0]?.score ?? null,
            contextualFollowUp: isContextualFollowUp,
            topicQuery: proposedTopicQuery,
          };

          if (searchResults.length === 0) {
            const previousMemory =
              this.readPreviousAssistantMemory(recentMessages);
            const lastClarification = conversationMemory.clarificationRequested
              ? conversationMemory
              : previousMemory;
            const lowConfidenceDecision = this.resolveLowConfidenceDecision(
              memoryPolicy,
              lastClarification,
            );
            clarificationAttempts = lowConfidenceDecision.attempts;
            shouldAutoHandoff = lowConfidenceDecision.shouldHandoff;
            clarificationRequested = !shouldAutoHandoff;
            answer = shouldAutoHandoff
              ? 'I cannot confirm that from the available knowledge right now. I have requested a human agent to help you.'
              : 'I could not find enough relevant information to answer that confidently. Could you rephrase your question or add a little more detail?';
            metadata = {
              model: 'local-guardrail',
              provider: 'local',
              adapter: 'retrieval-guardrail',
              usedFallback: true,
              handledWithoutKnowledge: false,
              retrieval: retrievalMetadata,
              memory: {
                clarificationRequested,
                clarificationAttempts,
              },
            };
          } else {
            activeTopicQuery = proposedTopicQuery;
            const chatResult = await this.chatService.answerWithContext({
              organizationId: conversation.organizationId,
              question: input.content,
              history: conversationHistory,
              safeFallback: true,
              context: searchResults.map((result) => ({
                content: result.content,
                score: result.score,
              })),
              signal: callbacks.signal,
              onDelta: callbacks.onDelta
                ? async (delta) => {
                    streamedAnswer = true;
                    await callbacks.onDelta?.(delta);
                  }
                : undefined,
              onReplace: callbacks.onReplace,
            });
            answer = chatResult.answer;
            if (streamedAnswer && chatResult.usedFallback) {
              await callbacks.onReplace?.(answer);
            }
            metadata = {
              model: chatResult.model,
              provider: chatResult.provider,
              adapter: chatResult.adapter,
              usedFallback: chatResult.usedFallback,
              handledWithoutKnowledge:
                chatResult.handledWithoutKnowledge ?? false,
              error: chatResult.error,
              retrieval: retrievalMetadata,
              memory: {
                clarificationRequested: false,
                clarificationAttempts: 0,
              },
            };
            shouldAutoHandoff =
              this.configService.get<boolean>(
                'CUSTOMER_CHAT_AUTO_HANDOFF_ON_FAILURE',
                true,
              ) && chatResult.usedFallback;
          }
        }
      }
    } catch (error) {
      if (this.isAbortError(error) || callbacks.signal?.aborted) {
        const updatedConversation = await this.loadConversation(
          conversation.id,
        );
        return {
          conversation: this.toConversationResponse(
            updatedConversation,
            publicResponse ? 'public' : 'internal',
          ),
          visitorMessage: this.toMessageResponse(
            visitorMessage,
            undefined,
            publicResponse,
          ),
          assistantMessage: null,
        };
      }
      return this.recoverFromAutoReplyFailure(
        currentUser,
        conversation,
        visitorMessage,
        publicResponse,
        error,
      );
    }

    this.throwIfAborted(callbacks.signal);
    if (!streamedAnswer) await callbacks.onDelta?.(answer);

    const assistantMessage = await this.prisma.$transaction(
      async (transaction) => {
        const claimed = await transaction.customerChatConversation.updateMany({
          where: {
            id: conversation.id,
            status: 'open',
            assignedAgentId: null,
          },
          data: {
            status: shouldAutoHandoff ? 'waiting_for_agent' : 'open',
            handoffRequestedAt: shouldAutoHandoff ? new Date() : undefined,
            lastMessageAt: new Date(),
            metadata: this.toJsonObject({
              ...this.toRecord(conversation.metadata),
              memory: {
                activeTopicQuery,
                clarificationRequested,
                clarificationAttempts,
              },
            }),
            version: { increment: 1 },
          },
        });
        if (claimed.count === 0) {
          return null;
        }
        return transaction.customerChatMessage.create({
          data: {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            role: 'assistant',
            content: answer,
            metadata: this.toJsonObject(metadata),
            citations: {
              create: searchResults.map((result) => ({
                chunkId: result.id,
                score: result.score,
              })),
            },
          },
          include: { citations: { include: { chunk: true } } },
        });
      },
    );

    const updatedConversation = await this.loadConversation(conversation.id);
    if (assistantMessage) {
      await this.publishConversationEvent(
        updatedConversation,
        shouldAutoHandoff ? 'handoff.requested' : 'message.created',
      );
    }
    if (assistantMessage && shouldAutoHandoff) {
      await this.auditService.record({
        actor: currentUser,
        organizationId: conversation.organizationId,
        action: 'customer_chat.auto_handoff_requested',
        entityType: 'customer_chat_conversation',
        entityId: conversation.id,
        metadata: {
          reason:
            searchResults.length === 0
              ? 'low_retrieval_confidence'
              : 'provider_failure',
        },
      });
    }

    return {
      conversation: this.toConversationResponse(
        updatedConversation,
        publicResponse ? 'public' : 'internal',
      ),
      visitorMessage: this.toMessageResponse(
        visitorMessage,
        undefined,
        publicResponse,
      ),
      assistantMessage: assistantMessage
        ? this.toMessageResponse(
            assistantMessage,
            searchResults,
            publicResponse,
          )
        : null,
    };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    );
  }

  private async recoverFromAutoReplyFailure(
    currentUser: AuthenticatedUser,
    conversation: ConversationContext,
    visitorMessage: MessageWithCitations,
    publicResponse: boolean,
    error: unknown,
  ) {
    const errorMessage = this.toErrorMessage(error);
    this.logger.error(
      `Automatic reply failed for conversation ${conversation.id}; handing off to an agent: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    const content = this.configService.get<string>(
      'CUSTOMER_CHAT_PROCESSING_FAILURE_MESSAGE',
      'I could not complete that request right now. I have asked a human agent to help you.',
    );

    const assistantMessage = await this.prisma.$transaction(
      async (transaction) => {
        const claimed = await transaction.customerChatConversation.updateMany({
          where: {
            id: conversation.id,
            status: 'open',
            assignedAgentId: null,
          },
          data: {
            status: 'waiting_for_agent',
            handoffRequestedAt: new Date(),
            lastMessageAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (claimed.count === 0) return null;

        return transaction.customerChatMessage.create({
          data: {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            role: 'assistant',
            content,
            metadata: this.toJsonObject({
              usedFallback: true,
              handoffRequested: true,
              failureCode: 'automatic_reply_failed',
            }),
          },
          include: { citations: { include: { chunk: true } } },
        });
      },
    );
    const updatedConversation = await this.loadConversation(conversation.id);

    if (assistantMessage) {
      try {
        await this.publishConversationEvent(
          updatedConversation,
          'handoff.requested',
        );
      } catch (publishError) {
        this.logger.warn(
          `Could not publish failure handoff for conversation ${conversation.id}: ${this.toErrorMessage(publishError)}`,
        );
      }
      try {
        await this.auditService.record({
          actor: currentUser,
          organizationId: conversation.organizationId,
          action: 'customer_chat.auto_handoff_requested',
          entityType: 'customer_chat_conversation',
          entityId: conversation.id,
          metadata: { reason: 'automatic_reply_failed', error: errorMessage },
        });
      } catch (auditError) {
        this.logger.warn(
          `Could not audit failure handoff for conversation ${conversation.id}: ${this.toErrorMessage(auditError)}`,
        );
      }
    }

    return {
      conversation: this.toConversationResponse(
        updatedConversation,
        publicResponse ? 'public' : 'internal',
      ),
      visitorMessage: this.toMessageResponse(
        visitorMessage,
        undefined,
        publicResponse,
      ),
      assistantMessage: assistantMessage
        ? this.toMessageResponse(assistantMessage, [], publicResponse)
        : null,
    };
  }

  private async markConversationWaiting(
    conversationId: string,
    organizationId: string,
  ): Promise<ConversationWithMessages> {
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.customerChatConversation.updateMany({
        where: { id: conversationId, status: { not: 'waiting_for_agent' } },
        data: {
          status: 'waiting_for_agent',
          handoffRequestedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (changed.count > 0) {
        await transaction.customerChatMessage.create({
          data: {
            organizationId,
            conversationId,
            role: 'system',
            content:
              'A human agent has been requested and will join this conversation.',
          },
        });
      }
      const updated = await transaction.customerChatConversation.findUnique({
        where: { id: conversationId },
        include: this.conversationInclude(),
      });
      if (!updated) {
        throw new NotFoundException('Customer chat conversation not found');
      }
      return updated;
    });
  }

  private async loadMessagePage(
    conversationId: string,
    input: ListCustomerChatMessagesDto,
    publicResponse: boolean,
  ) {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const where = { conversationId };
    const [total, messages] = await this.prisma.$transaction([
      this.prisma.customerChatMessage.count({ where }),
      this.prisma.customerChatMessage.findMany({
        where,
        include: { citations: { include: { chunk: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      data: messages.map((message) =>
        this.toMessageResponse(message, undefined, publicResponse),
      ),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private async purgeExpiredConversations() {
    try {
      const result = await this.prisma.customerChatConversation.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });
      if (result.count > 0) {
        this.logger.log(
          `Deleted ${result.count} customer chat conversations past retention`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Customer chat retention sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private assertPublicMessageLength(content: string) {
    const maxLength = this.configService.get<number>(
      'PUBLIC_CHAT_MAX_MESSAGE_LENGTH',
      2000,
    );

    if (content.length > maxLength) {
      throw new BadRequestException(
        `Message content must be at most ${maxLength} characters`,
      );
    }
  }

  private async limitPublicConversationMessages(conversationId: string) {
    const windowSeconds = this.configService.get<number>(
      'PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const limit = this.configService.get<number>(
      'PUBLIC_CHAT_MAX_MESSAGES_PER_CONVERSATION_PER_WINDOW',
      10,
    );

    await this.rateLimitService.consume(
      `public-chat:message:conversation:${conversationId}`,
      limit,
      windowSeconds,
    );
  }

  private async findConversationForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<ConversationWithMessages> {
    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: this.conversationInclude(),
    });

    if (!conversation) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      conversation.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    return conversation;
  }

  private async findConversationContextForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<ConversationContext> {
    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: { widgetConfig: { include: { folderScopes: true } } },
    });

    if (!conversation) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      conversation.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    return conversation;
  }

  private async findConversationForVisitor(
    id: string,
    visitorToken?: string,
    origin?: string,
  ): Promise<ConversationWithMessages> {
    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: this.conversationInclude(),
    });

    if (!conversation) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    this.assertVisitorConversationAccess(conversation, visitorToken, origin);

    return conversation;
  }

  private async findConversationContextForVisitor(
    id: string,
    visitorToken?: string,
    origin?: string,
  ): Promise<ConversationContext> {
    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: { widgetConfig: { include: { folderScopes: true } } },
    });

    if (!conversation) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    this.assertVisitorConversationAccess(conversation, visitorToken, origin);

    return conversation;
  }

  private assertVisitorConversationAccess(
    conversation: ConversationContext,
    visitorToken?: string,
    origin?: string,
  ) {
    if (!visitorToken) {
      throw new UnauthorizedException('Visitor token is required');
    }

    if (!conversation.visitorTokenHash) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    if (
      !this.matchesVisitorTokenHash(conversation.visitorTokenHash, visitorToken)
    ) {
      throw new UnauthorizedException('Invalid visitor token');
    }

    if (
      conversation.visitorTokenExpiresAt &&
      conversation.visitorTokenExpiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Visitor session has expired');
    }

    if (
      conversation.expiresAt &&
      conversation.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    if (!conversation.widgetConfig) {
      throw new NotFoundException('Customer chat widget not found');
    }
    this.assertOriginAllowed(conversation.widgetConfig.allowedDomains, origin);
  }

  private conversationConflict() {
    return new ConflictException(
      'Conversation was updated by another request. Refresh and try again.',
    );
  }

  private async loadConversation(
    id: string,
  ): Promise<ConversationWithMessages> {
    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: this.conversationInclude(),
    });
    if (!conversation) {
      throw new NotFoundException('Customer chat conversation not found');
    }
    return conversation;
  }

  private async ensureWidgetConfig(organizationId: string) {
    await this.assertCustomerChatEnabled(organizationId);
    const existing = await this.prisma.customerChatWidgetConfig.findFirst({
      where: { organizationId },
      include: { folderScopes: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    return this.prisma.customerChatWidgetConfig.create({
      data: { organizationId },
      include: { folderScopes: true },
    });
  }

  private async findEnabledWidgetConfig(widgetKey: string) {
    const config = await this.prisma.customerChatWidgetConfig.findUnique({
      where: { widgetKey },
      include: { folderScopes: true },
    });

    if (!config?.enabled) {
      throw new NotFoundException('Customer chat widget not found');
    }

    return config;
  }

  private async findWidgetConfigForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<WidgetConfigWithFolders> {
    const config = await this.prisma.customerChatWidgetConfig.findUnique({
      where: { id },
      include: { folderScopes: true },
    });
    if (
      !config ||
      (!this.isSuperAdmin(currentUser) &&
        config.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Customer chat widget not found');
    }
    return config;
  }

  private async assertWidgetFolders(
    organizationId: string,
    knowledgeScope: 'all' | 'folders',
    folderIds: string[],
  ) {
    if (knowledgeScope === 'all') return;
    const uniqueFolderIds = [...new Set(folderIds)];
    if (!uniqueFolderIds.length) {
      throw new BadRequestException(
        'Select at least one knowledge folder for this widget',
      );
    }
    const count = await this.prisma.knowledgeFolder.count({
      where: { organizationId, id: { in: uniqueFolderIds } },
    });
    if (count !== uniqueFolderIds.length) {
      throw new BadRequestException('Widget knowledge folder scope is invalid');
    }
  }

  private async assertCustomerChatEnabled(organizationId: string) {
    const entitlement = await this.prisma.organizationProduct.findFirst({
      where: {
        organizationId,
        status: 'enabled',
        product: { key: 'customer_chat', status: 'active' },
      },
    });

    if (!entitlement) {
      throw new ForbiddenException('Customer Chat is not enabled');
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

  private conversationInclude(messageLimit = 100) {
    return {
      widgetConfig: {
        include: { folderScopes: true },
      },
      messages: {
        include: {
          citations: {
            include: {
              chunk: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        take: messageLimit,
      },
    };
  }

  private toWidgetConfigResponse(config: WidgetConfigWithFolders) {
    return {
      id: config.id,
      organizationId: config.organizationId,
      name: config.name,
      widgetKey: config.widgetKey,
      enabled: config.enabled,
      knowledgeScope: config.knowledgeScope,
      folderIds: config.folderScopes.map((scope) => scope.folderId),
      greetingText: config.greetingText,
      allowedDomains: config.allowedDomains,
      settings: this.toRecord(config.settings),
    };
  }

  private toPublicWidgetConfigResponse(config: WidgetConfigWithFolders) {
    return {
      widgetKey: config.widgetKey,
      enabled: config.enabled,
      greetingText: config.greetingText,
      settings: this.toRecord(config.settings),
    };
  }

  private toConversationResponse(
    conversation: ConversationWithMessages,
    visibility: 'internal' | 'public' = 'internal',
  ) {
    const base = {
      id: conversation.id,
      status: conversation.status,
      version: conversation.version,
      assignedAgentId:
        visibility === 'internal' ? conversation.assignedAgentId : null,
      messages: [...conversation.messages]
        .reverse()
        .map((message) =>
          this.toMessageResponse(message, undefined, visibility === 'public'),
        ),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
    if (visibility === 'public') {
      return base;
    }
    return {
      ...base,
      organizationId: conversation.organizationId,
      visitorId: conversation.visitorId,
      visitorName: conversation.visitorName,
      visitorEmail: conversation.visitorEmail,
      handoffRequestedAt: conversation.handoffRequestedAt,
      lastMessageAt: conversation.lastMessageAt,
      expiresAt: conversation.expiresAt,
      widgetName: conversation.widgetConfig?.name ?? null,
      metadata: this.toRecord(conversation.metadata),
    };
  }

  private toMessageResponse(
    message: ConversationWithMessages['messages'][number],
    searchResults?: KnowledgeSearchRow[],
    publicResponse = false,
  ) {
    const searchResultByChunkId = new Map(
      searchResults?.map((result) => [result.id, result]) ?? [],
    );

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      metadata: publicResponse
        ? this.toPublicMessageMetadata(message.metadata)
        : this.toRecord(message.metadata),
      citations: message.citations.map((citation) => ({
        chunkId: citation.chunkId,
        score:
          searchResultByChunkId.get(citation.chunkId)?.score ?? citation.score,
        ...(publicResponse ? {} : { content: citation.chunk.content }),
      })),
      createdAt: message.createdAt,
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private normalizeWidgetSettings(
    input: Record<string, unknown> | undefined,
    existing: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const settings = { ...existing, ...(input ?? {}) };
    const policy = this.readWidgetMemoryPolicy(settings, true);
    return {
      ...settings,
      memoryEnabled: policy.enabled,
      recentMessageLimit: policy.recentMessageLimit,
      lowConfidenceAction: policy.lowConfidenceAction,
      maxClarificationAttempts: policy.maxClarificationAttempts,
    };
  }

  private readWidgetMemoryPolicy(
    value: Prisma.JsonValue | Record<string, unknown> | null | undefined,
    strict = false,
  ): WidgetMemoryPolicy {
    const settings =
      value && !Array.isArray(value) && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
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
    const activeTopicQuery = record.activeTopicQuery;
    return {
      activeTopicQuery:
        typeof activeTopicQuery === 'string' && activeTopicQuery.trim()
          ? activeTopicQuery
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
    messages: Array<{
      role: string;
      metadata: Prisma.JsonValue;
    }>,
  ): {
    clarificationRequested: boolean;
    clarificationAttempts: number;
  } {
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
    policy: WidgetMemoryPolicy,
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

  private toPublicMessageMetadata(
    value: Prisma.JsonValue,
  ): Record<string, unknown> {
    const metadata = this.toRecord(value);
    return {
      responseType:
        metadata.usedFallback === true
          ? 'fallback'
          : metadata.handledWithoutKnowledge === true
            ? 'automated'
            : 'generated',
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
    if (queryTerms.length === 0) return false;

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

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private assertOriginAllowed(allowedDomains: string[], origin?: string) {
    if (!allowedDomains.length) {
      const unrestricted = this.configService.get<boolean>(
        'ALLOW_UNRESTRICTED_WIDGET_ORIGINS',
        this.configService.get<string>('NODE_ENV') !== 'production',
      );
      if (unrestricted) return;
      throw new ForbiddenException('Widget has no allowed website origins');
    }

    if (!origin) {
      throw new ForbiddenException('Request origin is not allowed');
    }

    const normalizedOrigin = this.normalizeOrigin(origin);
    const isAllowed = allowedDomains.some((domain) => {
      try {
        return this.normalizeOrigin(domain) === normalizedOrigin;
      } catch {
        return false;
      }
    });

    if (!isAllowed) {
      throw new ForbiddenException('Request origin is not allowed');
    }
  }

  private createVisitorToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hashVisitorToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private matchesVisitorTokenHash(
    expectedHash: string,
    token: string,
  ): boolean {
    const actual = Buffer.from(this.hashVisitorToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private createSystemUser(organizationId: string): AuthenticatedUser {
    return {
      sub: 'public-widget',
      email: 'public-widget@agentcore.local',
      orgId: organizationId,
      roles: ['user'],
    };
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private assertAllowedDomainsForWidget(allowedDomains: string[]) {
    for (const domain of allowedDomains) {
      try {
        this.normalizeOrigin(domain);
      } catch {
        throw new BadRequestException(
          `Invalid allowed website origin: ${domain}`,
        );
      }
    }
    if (
      allowedDomains.length === 0 &&
      !this.configService.get<boolean>(
        'ALLOW_UNRESTRICTED_WIDGET_ORIGINS',
        this.configService.get<string>('NODE_ENV') !== 'production',
      )
    ) {
      throw new BadRequestException(
        'At least one allowed website origin is required',
      );
    }
  }

  private normalizeOrigin(value: string): string {
    const origin = new URL(value).origin.toLowerCase();
    if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
      throw new Error('Unsupported origin protocol');
    }
    return origin;
  }

  private addHours(value: Date, hours: number): Date {
    return new Date(value.getTime() + hours * 60 * 60 * 1000);
  }

  private addDays(value: Date, days: number): Date {
    return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private publishConversationEvent(
    conversation: Pick<ConversationWithMessages, 'id' | 'organizationId'>,
    type:
      | 'conversation.created'
      | 'conversation.updated'
      | 'message.created'
      | 'handoff.requested',
  ) {
    return this.realtimeService.publish({
      type,
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
    });
  }
}
