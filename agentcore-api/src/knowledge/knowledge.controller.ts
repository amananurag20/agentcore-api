import {
  Body,
  Controller,
  Delete,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { CreateKnowledgeSourceDto } from './dto/create-knowledge-source.dto';
import { KnowledgeDocumentResponseDto } from './dto/knowledge-document-response.dto';
import { KnowledgeSourceResponseDto } from './dto/knowledge-source-response.dto';
import { UpdateKnowledgeSourceDto } from './dto/update-knowledge-source.dto';
import { KnowledgeService } from './knowledge.service';

@ApiTags('Knowledge')
@ApiBearerAuth('bearer')
@Controller('knowledge')
@Roles('super_admin', 'org_admin')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Get('sources')
  @ApiOperation({
    summary: 'List knowledge sources visible to the current admin',
  })
  @ApiOkResponse({ type: KnowledgeSourceResponseDto, isArray: true })
  listSources(@CurrentUser() user: AuthenticatedUser) {
    return this.knowledgeService.listSources(user);
  }

  @Post('sources')
  @ApiOperation({ summary: 'Create a knowledge source' })
  @ApiCreatedResponse({ type: KnowledgeSourceResponseDto })
  createSource(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateKnowledgeSourceDto,
  ) {
    return this.knowledgeService.createSource(user, body);
  }

  @Get('sources/:id')
  @ApiOperation({ summary: 'Get a knowledge source by id' })
  @ApiOkResponse({ type: KnowledgeSourceResponseDto })
  getSourceById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.knowledgeService.getSourceById(user, id);
  }

  @Patch('sources/:id')
  @ApiOperation({ summary: 'Update a knowledge source' })
  @ApiOkResponse({ type: KnowledgeSourceResponseDto })
  updateSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateKnowledgeSourceDto,
  ) {
    return this.knowledgeService.updateSource(user, id, body);
  }

  @Delete('sources/:id')
  @ApiOperation({ summary: 'Delete a knowledge source' })
  @ApiOkResponse({
    schema: {
      example: { deleted: true },
    },
  })
  deleteSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.knowledgeService.deleteSource(user, id);
  }

  @Get('documents')
  @ApiOperation({ summary: 'List knowledge documents' })
  @ApiQuery({
    name: 'sourceId',
    required: false,
    description: 'Filter documents by source id.',
  })
  @ApiOkResponse({ type: KnowledgeDocumentResponseDto, isArray: true })
  listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Query('sourceId') sourceId?: string,
  ) {
    return this.knowledgeService.listDocuments(user, sourceId);
  }
}
