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
import { type CapturedLeadResult, LeadsService } from '../leads/leads.service';
import {
  AssignCustomerChatConversationDto,
  CustomerChatConversationAssignmentDto,
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
  include: { folderScopes: true; leadFields: true };
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
    private readonly leadsService: LeadsService,
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

    if (input.assignment === CustomerChatConversationAssignmentDto.assigned) {
      where.assignedAgentId = { not: null };
    } else if (
      input.assignment === CustomerChatConversationAssignmentDto.unassigned
    ) {
      where.assignedAgentId = null;
    }

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
            expiresAt: this.addDays(
              now,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
            version: { increment: 1 },
          },
        });
        if (claimed.count === 0) {
          throw this.conversationConflict();
        }
        if (conversation.leadId) {
          await this.leadsService.recordAgentResponse(transaction, {
            leadId: conversation.leadId,
            organizationId: conversation.organizationId,
            actorUserId: currentUser.sub,
            at: now,
          });
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

    const canManageAssignments = currentUser.roles.some((role) =>
      ['super_admin', 'org_admin', 'product_admin'].includes(role),
    );
    const isSelfClaim = assignedAgentId === currentUser.sub;

    if (!canManageAssignments) {
      if (!isSelfClaim) {
        throw new ForbiddenException(
          'Agents can only claim conversations for themselves',
        );
      }
      if (
        conversation.assignedAgentId &&
        conversation.assignedAgentId !== currentUser.sub
      ) {
        throw new ForbiddenException(
          'This conversation is assigned to another agent',
        );
      }
    }

    if (assignedAgentId && !isSelfClaim) {
      await this.assertAssignableAgent(
        conversation.organizationId,
        assignedAgentId,
      );
    }

    const expectedVersion = input.expectedVersion ?? conversation.version;
    const now = new Date();
    const updatedConversation = await this.prisma.$transaction(
      async (transaction) => {
        const changed = await transaction.customerChatConversation.updateMany({
          where: { id: conversation.id, version: expectedVersion },
          data: {
            assignedAgentId,
            status:
              conversation.status === 'closed'
                ? 'closed'
                : assignedAgentId
                  ? 'open'
                  : 'waiting_for_agent',
            handoffRequestedAt:
              !assignedAgentId && conversation.status !== 'closed'
                ? (conversation.handoffRequestedAt ?? now)
                : conversation.handoffRequestedAt,
            expiresAt: this.addDays(
              now,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
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
    const now = new Date();
    const updatedConversation = await this.prisma.$transaction(
      async (transaction) => {
        const changed = await transaction.customerChatConversation.updateMany({
          where: { id: conversation.id, version: expectedVersion },
          data: {
            status: input.status,
            handoffRequestedAt:
              input.status ===
              CustomerChatConversationStatusDto.waiting_for_agent
                ? (conversation.handoffRequestedAt ?? now)
                : conversation.handoffRequestedAt,
            expiresAt: this.addDays(
              now,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
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
        include: { folderScopes: true, leadFields: true },
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
    const leadFields = this.normalizeLeadFields(input.leadFields ?? []);

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
        leadFields: {
          create: leadFields,
        },
      },
      include: { folderScopes: true, leadFields: true },
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
    const leadFields =
      input.leadFields === undefined
        ? undefined
        : this.normalizeLeadFields(input.leadFields);
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
        leadFields: leadFields
          ? {
              deleteMany: {},
              create: leadFields,
            }
          : undefined,
      },
      include: { folderScopes: true, leadFields: true },
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
        leadFieldCount: leadFields?.length,
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

    const hasEnabledLeadFields = config.leadFields.some(
      (field) => field.enabled,
    );
    if (hasEnabledLeadFields && input.leadCaptureSubmitted !== true) {
      throw new BadRequestException(
        'Complete the pre-chat form before starting a conversation',
      );
    }

    const visitorToken = this.createVisitorToken();
    const now = new Date();
    const scoringPolicy = this.leadsService.readScoringPolicy(config.settings);
    const operationsPolicy = this.leadsService.readOperationsPolicy(
      config.settings,
    );
    const capture = this.leadsService.prepareCapture(
      config.leadFields,
      input.leadCapture,
      { name: input.visitorName, email: input.visitorEmail },
    );
    const createConversation = () =>
      this.prisma.$transaction(async (transaction) => {
        const leadResult = capture
          ? await this.leadsService.captureLead(transaction, capture, {
              organizationId: config.organizationId,
              widgetConfigId: config.id,
              visitorId: input.visitorId,
              metadata: input.metadata,
              scoringPolicy,
              operationsPolicy,
            })
          : null;
        const conversation = await transaction.customerChatConversation.create({
          data: {
            organizationId: config.organizationId,
            widgetConfigId: config.id,
            leadId: leadResult?.lead.id,
            visitorId: input.visitorId,
            visitorName: capture?.name ?? input.visitorName,
            visitorEmail: capture?.email ?? input.visitorEmail,
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
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
            metadata: this.toJsonObject(input.metadata),
          },
          include: this.conversationInclude(),
        });
        return { conversation, leadResult };
      });
    let result: Awaited<ReturnType<typeof createConversation>>;
    try {
      result = await createConversation();
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      result = await createConversation();
    }
    const { conversation, leadResult } = result;

    if (leadResult) {
      await this.auditService.record({
        organizationId: config.organizationId,
        action: `lead.${leadResult.action}`,
        entityType: 'lead',
        entityId: leadResult.lead.id,
        metadata: {
          widgetConfigId: config.id,
          conversationId: conversation.id,
          mergedLeadIds: leadResult.mergedLeadIds,
        },
      });
    }

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

  async closePublicConversation(
    conversationId: string,
    visitorToken?: string,
    origin?: string,
  ) {
    const conversation = await this.findConversationContextForVisitor(
      conversationId,
      visitorToken,
      origin,
    );
    const closeResult =
      conversation.status !== 'closed'
        ? await this.prisma.customerChatConversation.updateMany({
            where: { id: conversation.id, status: { not: 'closed' } },
            data: {
              status: 'closed',
              expiresAt: this.addDays(
                new Date(),
                this.configService.get<number>(
                  'CUSTOMER_CHAT_RETENTION_DAYS',
                  90,
                ),
              ),
              version: { increment: 1 },
            },
          })
        : { count: 0 };
    const updatedConversation = await this.loadConversation(conversation.id);
    if (closeResult.count > 0) {
      await this.auditService.record({
        actor: this.createSystemUser(conversation.organizationId),
        organizationId: conversation.organizationId,
        action: 'customer_chat.conversation_closed',
        entityType: 'customer_chat_conversation',
        entityId: conversation.id,
        metadata: {
          source: 'public_widget',
          reason: 'visitor_started_new_chat',
        },
      });
      await this.publishConversationEvent(
        updatedConversation,
        'conversation.updated',
      );
    }
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
    const scoringPolicy = this.leadsService.readScoringPolicy(
      conversation.widgetConfig?.settings,
    );
    const operationsPolicy = this.leadsService.readOperationsPolicy(
      conversation.widgetConfig?.settings,
    );
    const {
      visitorMessage,
      canAutoReply,
      duplicate,
      conversationalLeadResult,
      scoredLeadId,
    } = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.customerChatConversation.findUnique({
        where: { id: conversation.id },
        select: { status: true, assignedAgentId: true, leadId: true },
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
            conversationalLeadResult: null,
            scoredLeadId: current.leadId ?? conversation.leadId,
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
      let leadId = current.leadId ?? conversation.leadId;
      let conversationalLeadResult: CapturedLeadResult | null = null;
      if (!leadId && conversation.widgetConfig?.id) {
        const conversationalCapture =
          this.leadsService.prepareConversationalCapture(input.content);
        if (conversationalCapture) {
          conversationalLeadResult = await this.leadsService.captureLead(
            transaction,
            conversationalCapture,
            {
              organizationId: conversation.organizationId,
              widgetConfigId: conversation.widgetConfig.id,
              visitorId: conversation.visitorId ?? undefined,
              metadata: {
                ...this.toRecord(conversation.metadata),
                source: 'conversational_capture',
                conversationId: conversation.id,
              },
              scoringPolicy,
              operationsPolicy,
            },
          );
          leadId = conversationalLeadResult.lead.id;
        }
      }
      await transaction.customerChatConversation.update({
        where: { id: conversation.id },
        data: {
          leadId,
          visitorEmail: conversationalLeadResult?.lead.email ?? undefined,
          lastMessageAt: now,
          version: { increment: 1 },
          expiresAt: this.addDays(
            now,
            this.configService.get<number>('CUSTOMER_CHAT_RETENTION_DAYS', 90),
          ),
        },
      });
      if (leadId) {
        await this.leadsService.recordConversationActivity(transaction, {
          leadId,
          organizationId: conversation.organizationId,
          content: input.content,
          activityAt: now,
          policy: scoringPolicy,
          operationsPolicy,
        });
      }
      return {
        visitorMessage: message,
        canAutoReply:
          current.status === 'open' && current.assignedAgentId === null,
        duplicate: false,
        conversationalLeadResult,
        scoredLeadId: leadId,
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

    if (conversationalLeadResult) {
      await this.auditService.record({
        actor: currentUser,
        organizationId: conversation.organizationId,
        action: `lead.${conversationalLeadResult.action}`,
        entityType: 'lead',
        entityId: conversationalLeadResult.lead.id,
        metadata: {
          source: 'conversational_capture',
          conversationId: conversation.id,
          mergedLeadIds: conversationalLeadResult.mergedLeadIds,
        },
      });
    }

    if (scoredLeadId && scoringPolicy.aiEnabled) {
      try {
        const qualification = await this.chatService.extractLeadQualification({
          organizationId: conversation.organizationId,
          message: input.content,
          signal: callbacks.signal,
        });
        if (qualification) {
          await this.leadsService.recordAiQualification({
            leadId: scoredLeadId,
            organizationId: conversation.organizationId,
            qualification,
            activityAt: now,
            policy: scoringPolicy,
            operationsPolicy,
          });
        }
      } catch (error) {
        if (callbacks.signal?.aborted) throw error;
        this.logger.warn(
          `Could not apply AI lead qualification for conversation ${conversation.id}: ${this.toErrorMessage(error)}`,
        );
      }
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
    let citationResults: KnowledgeSearchRow[] = [];
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
    let responseLocale = this.readWidgetLocale(
      conversation.widgetConfig?.settings,
    );

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
          responseLocale = await this.chatService.detectLanguage(
            conversation.organizationId,
            input.content,
            responseLocale,
            callbacks.signal,
          );
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
          const fallbackRetrievalQuery = isContextualFollowUp
            ? `${topicQuery}\nFollow-up request: ${input.content}`
            : input.content;
          const retrievalQuery = conversationHistory.length
            ? await this.chatService.rewriteRetrievalQuery({
                organizationId: conversation.organizationId,
                question: input.content,
                history: conversationHistory,
                fallbackQuery: fallbackRetrievalQuery,
                signal: callbacks.signal,
              })
            : input.content;
          const proposedTopicQuery = retrievalQuery;
          const searchInput = {
            query: retrievalQuery,
            limit: 10,
            productKey: 'customer_chat' as const,
            folderIds:
              conversation.widgetConfig?.knowledgeScope === 'folders'
                ? conversation.widgetConfig.folderScopes.map(
                    (scope) => scope.folderId,
                  )
                : undefined,
          };
          const [candidates, clearanceDiagnostics] = await Promise.all([
            this.knowledgeService.search(searchUser, searchInput),
            this.knowledgeService.getSearchClearanceDiagnostics(
              searchUser,
              searchInput,
            ),
          ]);
          const minimumScore = this.configService.get<number>(
            'CUSTOMER_CHAT_MIN_SIMILARITY_SCORE',
            0.35,
          );
          const lexicalRescueMargin = this.configService.get<number>(
            'CUSTOMER_CHAT_LEXICAL_RESCUE_MARGIN',
            0.05,
          );
          searchResults = this.selectDiverseKnowledgeCandidates(
            candidates.filter(
              (result) =>
                result.score >= minimumScore ||
                (result.score >= minimumScore - lexicalRescueMargin &&
                  this.hasLexicalSupport(retrievalQuery, result.content)),
            ),
            5,
          );
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
            rewrittenQuery: retrievalQuery,
            topicQuery: proposedTopicQuery,
            responseLocale,
            effectiveClearance: clearanceDiagnostics.effectiveClearance,
            clearanceFilteredCount: clearanceDiagnostics.excludedChunkCount,
            clearanceBlockedAll:
              candidates.length === 0 &&
              clearanceDiagnostics.excludedChunkCount > 0,
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
              responseLocale,
            });
            citationResults = chatResult.usedFallback
              ? []
              : (
                  chatResult.includedContextIndexes ??
                  searchResults.map((_, index) => index)
                )
                  .map((index) => searchResults[index])
                  .filter((result): result is KnowledgeSearchRow =>
                    Boolean(result),
                  );
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
              promptBudget: chatResult.promptBudget,
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
        const activityAt = new Date();
        const claimed = await transaction.customerChatConversation.updateMany({
          where: {
            id: conversation.id,
            status: 'open',
            assignedAgentId: null,
          },
          data: {
            status: shouldAutoHandoff ? 'waiting_for_agent' : 'open',
            handoffRequestedAt: shouldAutoHandoff ? activityAt : undefined,
            lastMessageAt: activityAt,
            expiresAt: this.addDays(
              activityAt,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
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
              create: citationResults.map((result) => ({
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
    if (!assistantMessage && streamedAnswer) {
      await callbacks.onReplace?.('');
    }
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
        const activityAt = new Date();
        const claimed = await transaction.customerChatConversation.updateMany({
          where: {
            id: conversation.id,
            status: 'open',
            assignedAgentId: null,
          },
          data: {
            status: 'waiting_for_agent',
            handoffRequestedAt: activityAt,
            lastMessageAt: activityAt,
            expiresAt: this.addDays(
              activityAt,
              this.configService.get<number>(
                'CUSTOMER_CHAT_RETENTION_DAYS',
                90,
              ),
            ),
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
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.customerChatConversation.updateMany({
        where: { id: conversationId, status: { not: 'waiting_for_agent' } },
        data: {
          status: 'waiting_for_agent',
          handoffRequestedAt: now,
          lastMessageAt: now,
          expiresAt: this.addDays(
            now,
            this.configService.get<number>('CUSTOMER_CHAT_RETENTION_DAYS', 90),
          ),
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
        where: {
          status: 'closed',
          expiresAt: { lte: new Date() },
        },
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
      include: { folderScopes: true, leadFields: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    return this.prisma.customerChatWidgetConfig.create({
      data: { organizationId },
      include: { folderScopes: true, leadFields: true },
    });
  }

  private async findEnabledWidgetConfig(widgetKey: string) {
    const config = await this.prisma.customerChatWidgetConfig.findUnique({
      where: { widgetKey },
      include: { folderScopes: true, leadFields: true },
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
      include: { folderScopes: true, leadFields: true },
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
      leadFields: config.leadFields
        .sort((a, b) => a.position - b.position)
        .map((field) => ({
          id: field.id,
          key: field.key,
          label: field.label,
          type: field.type,
          mapping: field.mapping,
          required: field.required,
          enabled: field.enabled,
          placeholder: field.placeholder,
          options: field.options,
        })),
    };
  }

  private toPublicWidgetConfigResponse(config: WidgetConfigWithFolders) {
    return {
      widgetKey: config.widgetKey,
      enabled: config.enabled,
      greetingText: config.greetingText,
      settings: this.toRecord(config.settings),
      leadFields: config.leadFields
        .filter((field) => field.enabled)
        .sort((a, b) => a.position - b.position)
        .map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          options: field.options,
        })),
    };
  }

  private normalizeLeadFields(
    fields: NonNullable<CreateCustomerChatWidgetConfigDto['leadFields']>,
  ): Prisma.CustomerChatLeadFieldCreateWithoutWidgetConfigInput[] {
    const keys = new Set<string>();
    const mappings = new Set<string>();
    const configuredMappings = new Set(
      fields
        .map((field) => String(field.mapping ?? 'custom'))
        .filter((mapping) => mapping !== 'custom'),
    );
    return fields.map((field, position) => {
      const key = field.key.trim().toLowerCase();
      const label = field.label.trim();
      const mapping = String(field.mapping ?? 'custom');
      const fieldType = String(field.type);
      if (keys.has(key)) {
        throw new BadRequestException(`Duplicate lead field key: ${key}`);
      }
      keys.add(key);
      if (mapping !== 'custom') {
        if (mappings.has(mapping)) {
          throw new BadRequestException(
            `Only one lead field may map to ${mapping}`,
          );
        }
        mappings.add(mapping);
      }
      if (mapping === 'email' && fieldType !== 'email') {
        throw new BadRequestException(
          'The email mapping requires an email field',
        );
      }
      if (mapping === 'phone' && fieldType !== 'phone') {
        throw new BadRequestException(
          'The phone mapping requires a phone field',
        );
      }
      if (mapping === 'name' && fieldType !== 'text') {
        throw new BadRequestException('The name mapping requires a text field');
      }
      if (
        mapping === 'custom' &&
        ['name', 'email', 'phone'].includes(key) &&
        configuredMappings.has(key)
      ) {
        throw new BadRequestException(
          `Custom lead field key conflicts with the ${key} mapping`,
        );
      }
      if (
        (fieldType === 'select' || fieldType === 'radio') &&
        !(field.options ?? []).map((option) => option.trim()).filter(Boolean)
          .length
      ) {
        throw new BadRequestException(`${label} requires at least one option`);
      }
      return {
        key,
        label,
        type: field.type,
        mapping:
          mapping as Prisma.CustomerChatLeadFieldCreateWithoutWidgetConfigInput['mapping'],
        required: field.required ?? false,
        enabled: field.enabled ?? true,
        position,
        placeholder: field.placeholder?.trim() || null,
        options: [
          ...new Set(
            (field.options ?? [])
              .map((option) => option.trim())
              .filter(Boolean),
          ),
        ],
      };
    });
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
      leadId: conversation.leadId,
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
    const existingLeadScoring = this.toRecord(
      existing.leadScoring as Prisma.JsonValue,
    );
    const incomingLeadScoring = this.toRecord(
      input?.leadScoring as Prisma.JsonValue,
    );
    const existingLeadOperations = this.toRecord(
      existing.leadOperations as Prisma.JsonValue,
    );
    const incomingLeadOperations = this.toRecord(
      input?.leadOperations as Prisma.JsonValue,
    );
    const settings = {
      ...existing,
      ...(input ?? {}),
      leadScoring: { ...existingLeadScoring, ...incomingLeadScoring },
      leadOperations: { ...existingLeadOperations, ...incomingLeadOperations },
    };
    const policy = this.readWidgetMemoryPolicy(settings, true);
    const leadScoring = this.leadsService.readScoringPolicy(settings, true);
    const leadOperations = this.leadsService.readOperationsPolicy(
      settings,
      true,
    );
    return {
      ...settings,
      memoryEnabled: policy.enabled,
      recentMessageLimit: policy.recentMessageLimit,
      lowConfidenceAction: policy.lowConfidenceAction,
      maxClarificationAttempts: policy.maxClarificationAttempts,
      leadScoring,
      leadOperations,
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

  private readWidgetLocale(
    value: Prisma.JsonValue | Record<string, unknown> | null | undefined,
  ): string {
    const settings =
      value && !Array.isArray(value) && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const configured = settings.locale ?? settings.language;
    if (
      typeof configured === 'string' &&
      /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(configured.trim())
    ) {
      return configured.trim().replaceAll('_', '-');
    }
    return 'en';
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

  private selectDiverseKnowledgeCandidates(
    candidates: KnowledgeSearchRow[],
    limit: number,
  ): KnowledgeSearchRow[] {
    const maxPerDocument = Math.max(
      1,
      this.configService.get<number>(
        'CUSTOMER_CHAT_MAX_CHUNKS_PER_DOCUMENT',
        2,
      ),
    );
    const reranked = this.chatService.rerankKnowledgeCandidates(
      candidates,
      Math.min(candidates.length, Math.max(limit * 3, limit)),
    );
    const documentCounts = new Map<string, number>();
    const selected: KnowledgeSearchRow[] = [];
    for (const candidate of reranked) {
      const count = documentCounts.get(candidate.documentId) ?? 0;
      if (count >= maxPerDocument) continue;
      selected.push(candidate);
      documentCounts.set(candidate.documentId, count + 1);
      if (selected.length >= limit) break;
    }
    return selected;
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
    if (!allowedDomains.length) return;

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

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
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
