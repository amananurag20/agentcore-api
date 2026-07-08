import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import { Roles } from '../common/auth/roles.decorator';
import {
  AssignWhatsAppConversationDto,
  CreateWhatsAppConfigDto,
  ListWhatsAppConversationsDto,
  SendWhatsAppAgentMessageDto,
  UpdateWhatsAppConfigDto,
  UpdateWhatsAppConversationStatusDto,
  WhatsAppInboundWebhookDto,
} from './dto/whatsapp-assistant.dto';
import {
  WhatsAppConfigResponseDto,
  WhatsAppConversationListResponseDto,
  WhatsAppConversationResponseDto,
  WhatsAppInboundWebhookResponseDto,
} from './dto/whatsapp-assistant-response.dto';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';

@ApiTags('WhatsApp Assistant')
@ApiBearerAuth('bearer')
@Controller('whatsapp-assistant')
@Roles('super_admin', 'org_admin', 'agent')
export class WhatsAppAssistantController {
  constructor(
    private readonly whatsAppAssistantService: WhatsAppAssistantService,
  ) {}

  @Get('configs')
  @ApiOperation({ summary: 'List WhatsApp provider configs' })
  @ApiOkResponse({ type: WhatsAppConfigResponseDto, isArray: true })
  listConfigs(@CurrentUser() user: AuthenticatedUser) {
    return this.whatsAppAssistantService.listConfigs(user);
  }

  @Post('configs')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Create WhatsApp provider config placeholder' })
  @ApiCreatedResponse({ type: WhatsAppConfigResponseDto })
  createConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWhatsAppConfigDto,
  ) {
    return this.whatsAppAssistantService.createConfig(user, body);
  }

  @Patch('configs/:id')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Update WhatsApp provider config' })
  @ApiOkResponse({ type: WhatsAppConfigResponseDto })
  updateConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateWhatsAppConfigDto,
  ) {
    return this.whatsAppAssistantService.updateConfig(user, id, body);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List WhatsApp conversations' })
  @ApiOkResponse({ type: WhatsAppConversationListResponseDto })
  listConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWhatsAppConversationsDto,
  ) {
    return this.whatsAppAssistantService.listConversations(user, query);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get WhatsApp transcript/history' })
  @ApiOkResponse({ type: WhatsAppConversationResponseDto })
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.whatsAppAssistantService.getConversation(user, id);
  }

  @Post('conversations/:id/agent-messages')
  @ApiOperation({ summary: 'Send a human agent WhatsApp reply' })
  @ApiCreatedResponse({ type: WhatsAppInboundWebhookResponseDto })
  sendAgentMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendWhatsAppAgentMessageDto,
  ) {
    return this.whatsAppAssistantService.sendAgentMessage(user, id, body);
  }

  @Patch('conversations/:id/assignment')
  @ApiOperation({ summary: 'Assign or unassign a WhatsApp conversation' })
  @ApiOkResponse({ type: WhatsAppConversationResponseDto })
  assignConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AssignWhatsAppConversationDto,
  ) {
    return this.whatsAppAssistantService.assignConversation(user, id, body);
  }

  @Patch('conversations/:id/status')
  @ApiOperation({ summary: 'Update WhatsApp conversation status' })
  @ApiOkResponse({ type: WhatsAppConversationResponseDto })
  updateConversationStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateWhatsAppConversationStatusDto,
  ) {
    return this.whatsAppAssistantService.updateConversationStatus(
      user,
      id,
      body,
    );
  }

  @Patch('conversations/:id/handoff')
  @ApiOperation({ summary: 'Request human handoff for WhatsApp conversation' })
  @ApiOkResponse({ type: WhatsAppConversationResponseDto })
  requestHandoff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.whatsAppAssistantService.requestHandoff(user, id);
  }
}

@ApiTags('WhatsApp Assistant Webhook')
@Controller('whatsapp-assistant/webhook')
export class WhatsAppAssistantWebhookController {
  constructor(
    private readonly whatsAppAssistantService: WhatsAppAssistantService,
  ) {}

  @Public()
  @Get(':configId')
  @ApiOperation({ summary: 'Verify WhatsApp provider webhook' })
  verifyWebhook(
    @Param('configId') configId: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    return this.whatsAppAssistantService.verifyWebhook(
      configId,
      verifyToken,
      challenge,
    );
  }

  @Public()
  @Post(':configId/inbound')
  @ApiOperation({ summary: 'Receive inbound WhatsApp webhook message' })
  @ApiCreatedResponse({ type: WhatsAppInboundWebhookResponseDto })
  handleInboundWebhook(
    @Param('configId') configId: string,
    @Body() body: WhatsAppInboundWebhookDto,
  ) {
    return this.whatsAppAssistantService.handleInboundWebhook(configId, body);
  }
}
