import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

export class CreateAIProviderDto {
  @ApiPropertyOptional({
    description: 'Super admins may create configs for another organization.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({
    enum: ['openai', 'anthropic', 'local', 'custom'],
    example: 'openai',
  })
  @IsString()
  @IsIn(['openai', 'anthropic', 'local', 'custom'])
  provider: 'openai' | 'anthropic' | 'local' | 'custom';

  @ApiPropertyOptional({ enum: ['active', 'inactive'], example: 'active' })
  @IsString()
  @IsIn(['active', 'inactive'])
  @IsOptional()
  status?: 'active' | 'inactive';

  @ApiProperty({ example: 'Primary OpenAI', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'https://api.openai.com/v1' })
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @IsOptional()
  baseUrl?: string | null;

  @ApiPropertyOptional({ example: 'sk-...' })
  @IsString()
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional({ example: 'gpt-4.1-mini' })
  @IsString()
  @IsOptional()
  chatModel?: string;

  @ApiPropertyOptional({ example: 'text-embedding-3-small' })
  @IsString()
  @IsOptional()
  embeddingModel?: string;

  @ApiPropertyOptional({ example: 'bge-reranker-v2-m3' })
  @IsString()
  @IsOptional()
  rerankModel?: string;

  @ApiPropertyOptional({ example: 'whisper-1' })
  @IsString()
  @IsOptional()
  sttModel?: string;

  @ApiPropertyOptional({ example: 'tts-1' })
  @IsString()
  @IsOptional()
  ttsModel?: string;

  @ApiPropertyOptional({ example: { temperature: 0.2 } })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
