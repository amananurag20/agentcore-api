import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { ChatService } from '../ai/chat.service';
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

@Injectable()
export class CustomerChatService {
  constructor(
    private readonly auditService: AuditService,
    private readonly appointmentBookingService: AppointmentBookingService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly knowledgeService: KnowledgeService,
    private readonly prisma: PrismaService,
    private readonly rateLimitService: RateLimitService,
  ) {}

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
        metadata: this.toJsonObject(input.metadata),
      },
      include: this.conversationInclude(),
    });

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
        include: this.conversationInclude(),
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
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.assertCustomerChatEnabled(conversation.organizationId);

    const visitorMessage = await this.prisma.customerChatMessage.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        role: 'visitor',
        content: input.content,
      },
      include: {
        citations: {
          include: {
            chunk: true,
          },
        },
      },
    });

    if (input.appointmentAction) {
      const result = await this.appointmentBookingService.executeAction(
        conversation.organizationId,
        input.appointmentAction,
      );
      const answer = this.appointmentBookingService.formatActionResult(result);
      const assistantMessage = await this.prisma.customerChatMessage.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          role: 'assistant',
          content: answer,
          metadata: this.toJsonObject({
            appointmentAction: input.appointmentAction,
          }),
        },
        include: {
          citations: { include: { chunk: true } },
        },
      });
      const updatedConversation = await this.findConversationForActor(
        currentUser,
        id,
      );
      return {
        conversation: this.toConversationResponse(updatedConversation),
        visitorMessage: this.toMessageResponse(visitorMessage),
        assistantMessage: this.toMessageResponse(assistantMessage),
      };
    }

    const searchUser: AuthenticatedUser = {
      ...currentUser,
      orgId: conversation.organizationId,
    };
    const searchResults = await this.knowledgeService.search(searchUser, {
      query: input.content,
      limit: 5,
      productKey: 'customer_chat',
      folderIds:
        conversation.widgetConfig?.knowledgeScope === 'folders'
          ? conversation.widgetConfig.folderScopes.map(
              (scope) => scope.folderId,
            )
          : undefined,
    });
    const chatResult = await this.chatService.answerWithContext({
      organizationId: conversation.organizationId,
      question: input.content,
      context: searchResults.map((result) => ({
        content: result.content,
        score: result.score,
      })),
    });

    const assistantMessage = await this.prisma.customerChatMessage.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        role: 'assistant',
        content: chatResult.answer,
        metadata: this.toJsonObject({
          model: chatResult.model,
          provider: chatResult.provider,
          adapter: chatResult.adapter,
          usedFallback: chatResult.usedFallback,
          error: chatResult.error,
        }),
        citations: {
          create: searchResults.map((result) => ({
            chunkId: result.id,
            score: result.score,
          })),
        },
      },
      include: {
        citations: {
          include: {
            chunk: true,
          },
        },
      },
    });

    const updatedConversation = await this.findConversationForActor(
      currentUser,
      id,
    );

    return {
      conversation: this.toConversationResponse(updatedConversation),
      visitorMessage: this.toMessageResponse(visitorMessage),
      assistantMessage: this.toMessageResponse(assistantMessage, searchResults),
    };
  }

  async requestHandoff(currentUser: AuthenticatedUser, id: string) {
    const conversation = await this.findConversationForActor(currentUser, id);

    const updatedConversation =
      await this.prisma.customerChatConversation.update({
        where: { id: conversation.id },
        data: { status: 'waiting_for_agent' },
        include: this.conversationInclude(),
      });

    await this.auditService.record({
      actor: currentUser,
      organizationId: conversation.organizationId,
      action: 'customer_chat.handoff_requested',
      entityType: 'customer_chat_conversation',
      entityId: conversation.id,
    });

    return this.toConversationResponse(updatedConversation);
  }

  async sendAgentMessage(
    currentUser: AuthenticatedUser,
    id: string,
    input: SendAgentCustomerChatMessageDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);
    await this.assertCustomerChatEnabled(conversation.organizationId);

    const agentMessage = await this.prisma.customerChatMessage.create({
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
      include: {
        citations: {
          include: {
            chunk: true,
          },
        },
      },
    });

    const updatedConversation =
      await this.prisma.customerChatConversation.update({
        where: { id: conversation.id },
        data: {
          status:
            conversation.status === 'closed' ? 'open' : conversation.status,
          assignedAgentId: conversation.assignedAgentId ?? currentUser.sub,
        },
        include: this.conversationInclude(),
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
    const conversation = await this.findConversationForActor(currentUser, id);
    const assignedAgentId = input.assignedAgentId ?? null;

    if (assignedAgentId) {
      await this.assertAssignableAgent(
        conversation.organizationId,
        assignedAgentId,
      );
    }

    const updatedConversation =
      await this.prisma.customerChatConversation.update({
        where: { id: conversation.id },
        data: { assignedAgentId },
        include: this.conversationInclude(),
      });

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

    return this.toConversationResponse(updatedConversation);
  }

  async updateConversationStatus(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateCustomerChatConversationStatusDto,
  ) {
    const conversation = await this.findConversationForActor(currentUser, id);

    const updatedConversation =
      await this.prisma.customerChatConversation.update({
        where: { id: conversation.id },
        data: { status: input.status },
        include: this.conversationInclude(),
      });

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

    const config = await this.prisma.customerChatWidgetConfig.create({
      data: {
        organizationId,
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        knowledgeScope,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
        settings: this.toJsonObject(input.settings),
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
          ? this.toJsonObject(input.settings)
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
    const conversation = await this.prisma.customerChatConversation.create({
      data: {
        organizationId: config.organizationId,
        widgetConfigId: config.id,
        visitorId: input.visitorId,
        visitorName: input.visitorName,
        visitorEmail: input.visitorEmail,
        visitorTokenHash: this.hashVisitorToken(visitorToken),
        metadata: this.toJsonObject(input.metadata),
      },
      include: this.conversationInclude(),
    });

    return {
      conversation: this.toConversationResponse(conversation),
      visitorToken,
    };
  }

  async getPublicConversation(conversationId: string, visitorToken?: string) {
    const conversation = await this.findConversationForVisitor(
      conversationId,
      visitorToken,
    );

    return this.toConversationResponse(conversation);
  }

  async sendPublicMessage(
    conversationId: string,
    input: SendPublicCustomerChatMessageDto,
    visitorToken?: string,
  ) {
    this.assertPublicMessageLength(input.content);

    const conversation = await this.findConversationForVisitor(
      conversationId,
      visitorToken,
    );
    await this.limitPublicConversationMessages(conversation.id);

    const publicUser = this.createSystemUser(conversation.organizationId);

    return this.sendMessage(publicUser, conversation.id, input);
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

  private async findConversationForVisitor(
    id: string,
    visitorToken?: string,
  ): Promise<ConversationWithMessages> {
    if (!visitorToken) {
      throw new UnauthorizedException('Visitor token is required');
    }

    const conversation = await this.prisma.customerChatConversation.findUnique({
      where: { id },
      include: this.conversationInclude(),
    });

    if (!conversation?.visitorTokenHash) {
      throw new NotFoundException('Customer chat conversation not found');
    }

    if (conversation.visitorTokenHash !== this.hashVisitorToken(visitorToken)) {
      throw new UnauthorizedException('Invalid visitor token');
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

  private conversationInclude() {
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
        orderBy: { createdAt: 'asc' as const },
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

  private toConversationResponse(conversation: ConversationWithMessages) {
    const { widgetConfig, ...conversationData } = conversation;
    return {
      ...conversationData,
      widgetName: widgetConfig?.name ?? null,
      metadata: this.toRecord(conversation.metadata),
      messages: conversation.messages.map((message) =>
        this.toMessageResponse(message),
      ),
    };
  }

  private toMessageResponse(
    message: ConversationWithMessages['messages'][number],
    searchResults?: KnowledgeSearchRow[],
  ) {
    const searchResultByChunkId = new Map(
      searchResults?.map((result) => [result.id, result]) ?? [],
    );

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      metadata: this.toRecord(message.metadata),
      citations: message.citations.map((citation) => ({
        chunkId: citation.chunkId,
        score:
          searchResultByChunkId.get(citation.chunkId)?.score ?? citation.score,
        content: citation.chunk.content,
      })),
      createdAt: message.createdAt,
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

  private assertOriginAllowed(allowedDomains: string[], origin?: string) {
    if (!allowedDomains.length) {
      return;
    }

    if (!origin) {
      throw new ForbiddenException('Request origin is not allowed');
    }

    const normalizedOrigin = origin.replace(/\/+$/, '').toLowerCase();
    const isAllowed = allowedDomains.some(
      (domain) => domain.replace(/\/+$/, '').toLowerCase() === normalizedOrigin,
    );

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
}
