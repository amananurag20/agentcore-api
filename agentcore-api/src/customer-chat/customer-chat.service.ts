import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomerChatWidgetConfig, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { ChatService } from '../ai/chat.service';
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
import { UpdateCustomerChatWidgetConfigDto } from './dto/update-widget-config.dto';

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
  };
}>;

@Injectable()
export class CustomerChatService {
  constructor(
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

    const searchUser: AuthenticatedUser = {
      ...currentUser,
      orgId: conversation.organizationId,
    };
    const searchResults = await this.knowledgeService.search(searchUser, {
      query: input.content,
      limit: 5,
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
    const config = await this.prisma.customerChatWidgetConfig.upsert({
      where: { organizationId: currentUser.orgId },
      create: {
        organizationId: currentUser.orgId,
        enabled: input.enabled ?? true,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
        settings: this.toJsonObject(input.settings),
      },
      update: {
        enabled: input.enabled,
        greetingText: input.greetingText,
        allowedDomains: input.allowedDomains,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });

    return this.toWidgetConfigResponse(config);
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

    return this.prisma.customerChatWidgetConfig.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
  }

  private async findEnabledWidgetConfig(widgetKey: string) {
    const config = await this.prisma.customerChatWidgetConfig.findUnique({
      where: { widgetKey },
    });

    if (!config?.enabled) {
      throw new NotFoundException('Customer chat widget not found');
    }

    return config;
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

  private toWidgetConfigResponse(config: CustomerChatWidgetConfig) {
    return {
      organizationId: config.organizationId,
      widgetKey: config.widgetKey,
      enabled: config.enabled,
      greetingText: config.greetingText,
      allowedDomains: config.allowedDomains,
      settings: this.toRecord(config.settings),
    };
  }

  private toPublicWidgetConfigResponse(config: CustomerChatWidgetConfig) {
    return {
      widgetKey: config.widgetKey,
      enabled: config.enabled,
      greetingText: config.greetingText,
      settings: this.toRecord(config.settings),
    };
  }

  private toConversationResponse(conversation: ConversationWithMessages) {
    return {
      ...conversation,
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

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
