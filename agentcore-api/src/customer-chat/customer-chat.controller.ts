import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { RequireProductAccess } from '../common/auth/product-access.decorator';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import {
  AssignCustomerChatConversationDto,
  ListCustomerChatConversationsDto,
  SendAgentCustomerChatMessageDto,
  UpdateCustomerChatConversationStatusDto,
} from './dto/agent-inbox.dto';
import { CreateCustomerChatConversationDto } from './dto/create-conversation.dto';
import {
  CustomerChatAgentMessageResponseDto,
  CustomerChatConversationDto,
  CustomerChatConversationListDto,
  CustomerChatSendMessageResponseDto,
  CustomerChatWidgetConfigDto,
  CustomerChatWidgetConfigListDto,
  PublicCustomerChatConversationCreatedDto,
} from './dto/customer-chat-response.dto';
import { ListCustomerChatWidgetConfigsDto } from './dto/list-widget-configs.dto';
import {
  CreatePublicCustomerChatConversationDto,
  SendPublicCustomerChatMessageDto,
} from './dto/public-widget.dto';
import { SendCustomerChatMessageDto } from './dto/send-message.dto';
import {
  CreateCustomerChatWidgetConfigDto,
  UpdateCustomerChatWidgetConfigDto,
} from './dto/update-widget-config.dto';
import { CustomerChatService } from './customer-chat.service';

@ApiTags('Customer Chat')
@ApiBearerAuth('bearer')
@Controller('customer-chat')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent', 'user')
@RequireProductAccess('customer_chat')
export class CustomerChatController {
  constructor(private readonly customerChatService: CustomerChatService) {}

  @Post('conversations')
  @ApiOperation({ summary: 'Create a customer chat conversation' })
  @ApiCreatedResponse({ type: CustomerChatConversationDto })
  createConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCustomerChatConversationDto,
  ) {
    return this.customerChatService.createConversation(user, body);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List customer chat conversations for agent inbox' })
  @ApiOkResponse({ type: CustomerChatConversationListDto })
  listConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCustomerChatConversationsDto,
  ) {
    return this.customerChatService.listConversations(user, query);
  }

  @Get('widget-config')
  @ApiOperation({ summary: 'Get customer chat widget config' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  getWidgetConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.customerChatService.getWidgetConfig(user);
  }

  @Patch('widget-config')
  @RequireProductAccess('customer_chat', 'configure')
  @ApiOperation({ summary: 'Update customer chat widget config' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  updateWidgetConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCustomerChatWidgetConfigDto,
  ) {
    return this.customerChatService.updateWidgetConfig(user, body);
  }

  @Get('widget-configs')
  @ApiOperation({ summary: 'List customer chat widgets' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigListDto })
  listWidgetConfigs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCustomerChatWidgetConfigsDto,
  ) {
    return this.customerChatService.listWidgetConfigs(user, query);
  }

  @Post('widget-configs')
  @RequireProductAccess('customer_chat', 'configure')
  @ApiOperation({ summary: 'Create a customer chat widget' })
  @ApiCreatedResponse({ type: CustomerChatWidgetConfigDto })
  createWidgetConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCustomerChatWidgetConfigDto,
  ) {
    return this.customerChatService.createWidgetConfig(user, body);
  }

  @Get('widget-configs/:id')
  @ApiOperation({ summary: 'Get a customer chat widget' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  getWidgetConfigById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.customerChatService.getWidgetConfigById(user, id);
  }

  @Patch('widget-configs/:id')
  @RequireProductAccess('customer_chat', 'configure')
  @ApiOperation({ summary: 'Update a customer chat widget' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  updateWidgetConfigById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateCustomerChatWidgetConfigDto,
  ) {
    return this.customerChatService.updateWidgetConfigById(user, id, body);
  }

  @Delete('widget-configs/:id')
  @RequireProductAccess('customer_chat', 'configure')
  @ApiOperation({ summary: 'Delete a customer chat widget' })
  deleteWidgetConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.customerChatService.deleteWidgetConfig(user, id);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get a customer chat conversation' })
  @ApiOkResponse({ type: CustomerChatConversationDto })
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.customerChatService.getConversation(user, id);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Send a RAG-grounded visitor message' })
  @ApiCreatedResponse({ type: CustomerChatSendMessageResponseDto })
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendCustomerChatMessageDto,
  ) {
    return this.customerChatService.sendMessage(user, id, body);
  }

  @Post('conversations/:id/agent-messages')
  @ApiOperation({ summary: 'Send a human agent reply' })
  @ApiCreatedResponse({ type: CustomerChatAgentMessageResponseDto })
  sendAgentMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendAgentCustomerChatMessageDto,
  ) {
    return this.customerChatService.sendAgentMessage(user, id, body);
  }

  @Patch('conversations/:id/assignment')
  @ApiOperation({ summary: 'Assign or unassign a customer chat conversation' })
  @ApiOkResponse({ type: CustomerChatConversationDto })
  assignConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AssignCustomerChatConversationDto,
  ) {
    return this.customerChatService.assignConversation(user, id, body);
  }

  @Patch('conversations/:id/status')
  @ApiOperation({ summary: 'Update customer chat conversation status' })
  @ApiOkResponse({ type: CustomerChatConversationDto })
  updateConversationStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateCustomerChatConversationStatusDto,
  ) {
    return this.customerChatService.updateConversationStatus(user, id, body);
  }

  @Patch('conversations/:id/handoff')
  @ApiOperation({ summary: 'Request human agent handoff' })
  @ApiOkResponse({ type: CustomerChatConversationDto })
  requestHandoff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.customerChatService.requestHandoff(user, id);
  }
}

@ApiTags('Customer Chat Widget')
@Controller('customer-chat/widget')
export class CustomerChatWidgetController {
  constructor(
    private readonly configService: ConfigService,
    private readonly customerChatService: CustomerChatService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Public()
  @Get(':widgetKey/config')
  @ApiOperation({ summary: 'Get public customer chat widget config' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  async getPublicWidgetConfig(
    @Param('widgetKey') widgetKey: string,
    @Req() request: Request,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    await this.limitPublicRequest({
      action: 'config',
      clientIp: this.getClientIp(request),
      widgetKey,
      maxEnvKey: 'PUBLIC_CHAT_MAX_CONFIG_FETCHES_PER_WINDOW',
      defaultMax: 120,
    });

    return this.customerChatService.getPublicWidgetConfig(
      widgetKey,
      origin ?? referer,
    );
  }

  @Public()
  @Post(':widgetKey/conversations')
  @ApiOperation({ summary: 'Create a public widget conversation' })
  @ApiCreatedResponse({ type: PublicCustomerChatConversationCreatedDto })
  async createPublicConversation(
    @Param('widgetKey') widgetKey: string,
    @Body() body: CreatePublicCustomerChatConversationDto,
    @Req() request: Request,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    await this.limitPublicRequest({
      action: 'conversation',
      clientIp: this.getClientIp(request),
      widgetKey,
      maxEnvKey: 'PUBLIC_CHAT_MAX_CONVERSATIONS_PER_WINDOW',
      defaultMax: 10,
    });

    return this.customerChatService.createPublicConversation(
      widgetKey,
      body,
      origin ?? referer,
    );
  }

  @Public()
  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get a public widget conversation' })
  @ApiOkResponse({ type: CustomerChatConversationDto })
  getPublicConversation(
    @Param('id') id: string,
    @Headers('x-visitor-token') visitorToken?: string,
  ) {
    return this.customerChatService.getPublicConversation(id, visitorToken);
  }

  @Public()
  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Send a public widget visitor message' })
  @ApiCreatedResponse({ type: CustomerChatSendMessageResponseDto })
  async sendPublicMessage(
    @Param('id') id: string,
    @Body() body: SendPublicCustomerChatMessageDto,
    @Req() request: Request,
    @Headers('x-visitor-token') visitorToken?: string,
  ) {
    await this.limitPublicRequest({
      action: 'message',
      clientIp: this.getClientIp(request),
      maxEnvKey: 'PUBLIC_CHAT_MAX_MESSAGES_PER_WINDOW',
      defaultMax: 20,
    });

    return this.customerChatService.sendPublicMessage(id, body, visitorToken);
  }

  private async limitPublicRequest(input: {
    action: string;
    clientIp: string;
    maxEnvKey: string;
    defaultMax: number;
    widgetKey?: string;
  }) {
    const windowSeconds = this.configService.get<number>(
      'PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const limit = this.configService.get<number>(
      input.maxEnvKey,
      input.defaultMax,
    );

    await this.rateLimitService.consume(
      `public-chat:${input.action}:ip:${input.clientIp}`,
      limit,
      windowSeconds,
    );

    if (input.widgetKey) {
      await this.rateLimitService.consume(
        `public-chat:${input.action}:widget:${input.widgetKey}`,
        limit,
        windowSeconds,
      );
    }
  }

  private getClientIp(request: Request): string {
    const forwardedFor = request.headers['x-forwarded-for'];

    if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
      return forwardedFor.split(',')[0].trim();
    }

    if (Array.isArray(forwardedFor) && forwardedFor[0]) {
      return forwardedFor[0].split(',')[0].trim();
    }

    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
