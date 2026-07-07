import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CustomerChatWidgetConfig, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { ChatService } from '../ai/chat.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import {
  KnowledgeSearchRow,
  KnowledgeService,
} from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly knowledgeService: KnowledgeService,
    private readonly prisma: PrismaService,
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
    const conversation = await this.findConversationForVisitor(
      conversationId,
      visitorToken,
    );
    const publicUser = this.createSystemUser(conversation.organizationId);

    return this.sendMessage(publicUser, conversation.id, input);
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
