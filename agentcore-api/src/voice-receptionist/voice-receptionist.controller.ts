import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
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
  AssignVoiceCallDto,
  CreateVoiceConfigDto,
  ListVoiceCallsDto,
  RouteVoiceCallDto,
  SendVoiceAgentMessageDto,
  UpdateVoiceCallStatusDto,
  UpdateVoiceConfigDto,
  VoiceWebhookEventDto,
} from './dto/voice-receptionist.dto';
import {
  VoiceCallListResponseDto,
  VoiceCallResponseDto,
  VoiceConfigResponseDto,
  VoiceWebhookResponseDto,
} from './dto/voice-receptionist-response.dto';
import { VoiceReceptionistService } from './voice-receptionist.service';

type RawBodyRequest = {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
};

@ApiTags('Voice Receptionist')
@ApiBearerAuth('bearer')
@Controller('voice-receptionist')
@Roles('super_admin', 'org_admin', 'agent')
export class VoiceReceptionistController {
  constructor(
    private readonly voiceReceptionistService: VoiceReceptionistService,
  ) {}

  @Get('configs')
  @ApiOperation({ summary: 'List voice provider configs' })
  @ApiOkResponse({ type: VoiceConfigResponseDto, isArray: true })
  listConfigs(@CurrentUser() user: AuthenticatedUser) {
    return this.voiceReceptionistService.listConfigs(user);
  }

  @Post('configs')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Create voice provider config placeholder' })
  @ApiCreatedResponse({ type: VoiceConfigResponseDto })
  createConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateVoiceConfigDto,
  ) {
    return this.voiceReceptionistService.createConfig(user, body);
  }

  @Patch('configs/:id')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Update voice provider config' })
  @ApiOkResponse({ type: VoiceConfigResponseDto })
  updateConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateVoiceConfigDto,
  ) {
    return this.voiceReceptionistService.updateConfig(user, id, body);
  }

  @Get('calls')
  @ApiOperation({ summary: 'List voice calls' })
  @ApiOkResponse({ type: VoiceCallListResponseDto })
  listCalls(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVoiceCallsDto,
  ) {
    return this.voiceReceptionistService.listCalls(user, query);
  }

  @Get('calls/:id')
  @ApiOperation({ summary: 'Get voice call transcript/history' })
  @ApiOkResponse({ type: VoiceCallResponseDto })
  getCall(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.voiceReceptionistService.getCall(user, id);
  }

  @Post('calls/:id/agent-messages')
  @ApiOperation({ summary: 'Speak a human agent message into a voice call' })
  @ApiCreatedResponse({ type: VoiceWebhookResponseDto })
  sendAgentMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendVoiceAgentMessageDto,
  ) {
    return this.voiceReceptionistService.sendAgentMessage(user, id, body);
  }

  @Patch('calls/:id/assignment')
  @ApiOperation({ summary: 'Assign or unassign a voice call' })
  @ApiOkResponse({ type: VoiceCallResponseDto })
  assignCall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: AssignVoiceCallDto,
  ) {
    return this.voiceReceptionistService.assignCall(user, id, body);
  }

  @Patch('calls/:id/status')
  @ApiOperation({ summary: 'Update voice call status' })
  @ApiOkResponse({ type: VoiceCallResponseDto })
  updateCallStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateVoiceCallStatusDto,
  ) {
    return this.voiceReceptionistService.updateCallStatus(user, id, body);
  }

  @Patch('calls/:id/handoff')
  @ApiOperation({ summary: 'Request human handoff for a voice call' })
  @ApiOkResponse({ type: VoiceCallResponseDto })
  requestHandoff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.voiceReceptionistService.requestHandoff(user, id);
  }

  @Post('calls/:id/route')
  @ApiOperation({ summary: 'Route a call to transfer, voicemail, or close' })
  routeCall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: RouteVoiceCallDto,
  ) {
    return this.voiceReceptionistService.routeCall(user, id, body);
  }
}

@ApiTags('Voice Receptionist Webhook')
@Controller('voice-receptionist/webhook')
export class VoiceReceptionistWebhookController {
  constructor(
    private readonly voiceReceptionistService: VoiceReceptionistService,
  ) {}

  @Public()
  @Get(':configId')
  @ApiOperation({ summary: 'Verify voice provider webhook' })
  verifyWebhook(
    @Param('configId') configId: string,
    @Query('verify_token') verifyToken?: string,
    @Query('challenge') challenge?: string,
  ) {
    return this.voiceReceptionistService.verifyWebhook(
      configId,
      verifyToken,
      challenge,
    );
  }

  @Public()
  @Post(':configId/events')
  @ApiOperation({ summary: 'Receive voice call webhook event' })
  @ApiCreatedResponse({ type: VoiceWebhookResponseDto })
  handleWebhookEvent(
    @Param('configId') configId: string,
    @Body() body: VoiceWebhookEventDto,
    @Req() request: RawBodyRequest,
  ) {
    return this.voiceReceptionistService.handleWebhookEvent(
      configId,
      body,
      request.rawBody,
      request.headers,
    );
  }
}
