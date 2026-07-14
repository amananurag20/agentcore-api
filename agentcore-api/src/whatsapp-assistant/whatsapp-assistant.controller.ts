import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
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
import { RequireProductAccess } from '../common/auth/product-access.decorator';
import {
  AssignWhatsAppConversationDto,
  CreateWhatsAppConfigDto,
  ListWhatsAppConversationsDto,
  SendWhatsAppAgentMessageDto,
  SendWhatsAppMediaMessageDto,
  SendWhatsAppTemplateMessageDto,
  UpdateWhatsAppConfigDto,
  UpdateWhatsAppConversationStatusDto,
} from './dto/whatsapp-assistant.dto';
import {
  WhatsAppConfigResponseDto,
  WhatsAppConversationListResponseDto,
  WhatsAppConversationResponseDto,
  WhatsAppInboundWebhookResponseDto,
  WhatsAppTemplateResponseDto,
} from './dto/whatsapp-assistant-response.dto';
import { WhatsAppAssistantService } from './whatsapp-assistant.service';

type RawBodyRequest = {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};

@ApiTags('WhatsApp Assistant')
@ApiBearerAuth('bearer')
@Controller('whatsapp-assistant')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent', 'user')
@RequireProductAccess('whatsapp_assistant')
export class WhatsAppAssistantController {
  constructor(
    private readonly whatsAppAssistantService: WhatsAppAssistantService,
  ) {}

  @Get('configs')
  @ApiOperation({ summary: 'List WhatsApp provider configs' })
  @ApiOkResponse({ type: WhatsAppConfigResponseDto, isArray: true })
  listConfigs(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.whatsAppAssistantService.listConfigs(user, organizationId);
  }

  @Post('configs')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('whatsapp_assistant', 'configure')
  @ApiOperation({ summary: 'Create WhatsApp provider config placeholder' })
  @ApiCreatedResponse({ type: WhatsAppConfigResponseDto })
  createConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWhatsAppConfigDto,
  ) {
    return this.whatsAppAssistantService.createConfig(user, body);
  }

  @Patch('configs/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('whatsapp_assistant', 'configure')
  @ApiOperation({ summary: 'Update WhatsApp provider config' })
  @ApiOkResponse({ type: WhatsAppConfigResponseDto })
  updateConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateWhatsAppConfigDto,
  ) {
    return this.whatsAppAssistantService.updateConfig(user, id, body);
  }

  @Get('configs/:id/templates')
  @Roles('super_admin', 'org_admin', 'product_admin', 'agent')
  @ApiOperation({ summary: 'List synced WhatsApp templates' })
  @ApiOkResponse({ type: WhatsAppTemplateResponseDto, isArray: true })
  listTemplates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.whatsAppAssistantService.listTemplates(user, id);
  }

  @Post('configs/:id/templates/sync')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('whatsapp_assistant', 'configure')
  @ApiOperation({ summary: 'Sync approved templates from Meta' })
  @ApiOkResponse({ type: WhatsAppTemplateResponseDto, isArray: true })
  syncTemplates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.whatsAppAssistantService.syncTemplates(user, id);
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

  @Get('messages/:id/media')
  @ApiOperation({ summary: 'Download securely stored inbound WhatsApp media' })
  async getMessageMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const media = await this.whatsAppAssistantService.getMessageMedia(user, id);
    const safeName = media.fileName.replace(/[^a-zA-Z0-9._-]+/g, '-');
    return new StreamableFile(media.buffer, {
      type: media.mimeType,
      disposition: `attachment; filename="${safeName}"`,
    });
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

  @Post('conversations/:id/template-messages')
  @ApiOperation({ summary: 'Send an approved WhatsApp template message' })
  sendTemplateMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendWhatsAppTemplateMessageDto,
  ) {
    return this.whatsAppAssistantService.sendTemplateMessage(user, id, body);
  }

  @Post('conversations/:id/media-messages')
  @ApiOperation({
    summary: 'Send a WhatsApp media message inside the 24h window',
  })
  sendMediaMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendWhatsAppMediaMessageDto,
  ) {
    return this.whatsAppAssistantService.sendMediaMessage(user, id, body);
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
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive inbound WhatsApp webhook message' })
  @ApiOkResponse({
    description: 'Webhook accepted for asynchronous processing',
  })
  handleInboundWebhook(
    @Param('configId') configId: string,
    @Body() body: unknown,
    @Req() request: RawBodyRequest,
  ) {
    return this.whatsAppAssistantService.receiveInboundWebhook(
      configId,
      body,
      request.rawBody,
      request.headers,
      request.ip,
    );
  }
}
