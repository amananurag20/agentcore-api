import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { Roles } from '../common/auth/roles.decorator';
import { AIProvidersService } from './ai-providers.service';
import { AIProviderResponseDto } from './dto/ai-provider-response.dto';
import { CreateAIProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAIProviderDto } from './dto/update-ai-provider.dto';

@ApiTags('AI Providers')
@ApiBearerAuth('bearer')
@Controller('ai/providers')
@Roles('super_admin', 'org_admin')
export class AIProvidersController {
  constructor(private readonly aiProvidersService: AIProvidersService) {}

  @Get()
  @ApiOperation({
    summary: 'List AI provider configs visible to the current admin',
  })
  @ApiOkResponse({ type: AIProviderResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.aiProvidersService.list(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create an AI provider config' })
  @ApiCreatedResponse({ type: AIProviderResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAIProviderDto,
  ) {
    return this.aiProvidersService.create(user, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an AI provider config by id' })
  @ApiOkResponse({ type: AIProviderResponseDto })
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.aiProvidersService.getById(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an AI provider config' })
  @ApiOkResponse({ type: AIProviderResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAIProviderDto,
  ) {
    return this.aiProvidersService.update(user, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an AI provider config' })
  @ApiOkResponse({
    schema: {
      example: { deleted: true },
    },
  })
  delete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.aiProvidersService.delete(user, id);
  }
}
