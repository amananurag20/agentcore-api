import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
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
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { CreateCustomerChatConversationDto } from './dto/create-conversation.dto';
import {
  CustomerChatConversationDto,
  CustomerChatSendMessageResponseDto,
  CustomerChatWidgetConfigDto,
  PublicCustomerChatConversationCreatedDto,
} from './dto/customer-chat-response.dto';
import {
  CreatePublicCustomerChatConversationDto,
  SendPublicCustomerChatMessageDto,
} from './dto/public-widget.dto';
import { SendCustomerChatMessageDto } from './dto/send-message.dto';
import { UpdateCustomerChatWidgetConfigDto } from './dto/update-widget-config.dto';
import { CustomerChatService } from './customer-chat.service';

@ApiTags('Customer Chat')
@ApiBearerAuth('bearer')
@Controller('customer-chat')
@Roles('super_admin', 'org_admin', 'agent')
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

  @Get('widget-config')
  @ApiOperation({ summary: 'Get customer chat widget config' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  getWidgetConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.customerChatService.getWidgetConfig(user);
  }

  @Patch('widget-config')
  @ApiOperation({ summary: 'Update customer chat widget config' })
  @ApiOkResponse({ type: CustomerChatWidgetConfigDto })
  updateWidgetConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCustomerChatWidgetConfigDto,
  ) {
    return this.customerChatService.updateWidgetConfig(user, body);
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
