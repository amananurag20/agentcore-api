import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { CreateCustomerChatConversationDto } from './dto/create-conversation.dto';
import {
  CustomerChatConversationDto,
  CustomerChatSendMessageResponseDto,
} from './dto/customer-chat-response.dto';
import { SendCustomerChatMessageDto } from './dto/send-message.dto';
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
