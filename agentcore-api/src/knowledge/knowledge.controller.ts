import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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
import { KnowledgeChunkResponseDto } from './dto/knowledge-chunk-response.dto';
import { KnowledgeDocumentResponseDto } from './dto/knowledge-document-response.dto';
import { KnowledgeSearchResultDto } from './dto/knowledge-search-result.dto';
import { KnowledgeSourceResponseDto } from './dto/knowledge-source-response.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { UpdateKnowledgeSourceDto } from './dto/update-knowledge-source.dto';
import { UploadKnowledgeFileDto } from './dto/upload-knowledge-file.dto';
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

  @Post('search')
  @ApiOperation({ summary: 'Semantic search over organization knowledge' })
  @ApiOkResponse({ type: KnowledgeSearchResultDto, isArray: true })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SearchKnowledgeDto,
  ) {
    return this.knowledgeService.search(user, body);
  }

  @Post('sources/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a file knowledge source to object storage' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'file'],
      properties: {
        organizationId: {
          type: 'string',
          example: 'org_demo',
        },
        name: {
          type: 'string',
          example: 'Restaurant Menu',
        },
        metadata: {
          type: 'string',
          example: '{"locale":"en"}',
        },
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: KnowledgeSourceResponseDto })
  uploadFileSource(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UploadKnowledgeFileDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.knowledgeService.uploadFileSource(user, body, file);
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

  @Post('sources/:id/ingest')
  @ApiOperation({ summary: 'Run or retry ingestion for a knowledge source' })
  @ApiOkResponse({ type: KnowledgeSourceResponseDto })
  ingestSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.knowledgeService.ingestSource(user, id);
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

  @Get('chunks')
  @ApiOperation({ summary: 'List knowledge chunks' })
  @ApiQuery({
    name: 'sourceId',
    required: false,
    description: 'Filter chunks by source id.',
  })
  @ApiQuery({
    name: 'documentId',
    required: false,
    description: 'Filter chunks by document id.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Simple keyword search against chunk content.',
  })
  @ApiOkResponse({ type: KnowledgeChunkResponseDto, isArray: true })
  listChunks(
    @CurrentUser() user: AuthenticatedUser,
    @Query('sourceId') sourceId?: string,
    @Query('documentId') documentId?: string,
    @Query('q') q?: string,
  ) {
    return this.knowledgeService.listChunks(user, { sourceId, documentId, q });
  }
}
