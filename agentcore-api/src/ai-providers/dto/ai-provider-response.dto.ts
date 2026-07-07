import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AIProviderResponseDto {
  @ApiProperty({ example: '7c2de76e-df14-4908-a189-c5e2b09655f4' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiProperty({
    enum: ['openai', 'anthropic', 'local', 'custom'],
    example: 'openai',
  })
  provider: 'openai' | 'anthropic' | 'local' | 'custom';

  @ApiProperty({ enum: ['active', 'inactive'], example: 'active' })
  status: 'active' | 'inactive';

  @ApiProperty({ example: 'Primary OpenAI' })
  name: string;

  @ApiPropertyOptional({ example: 'https://api.openai.com/v1' })
  baseUrl?: string | null;

  @ApiProperty({ example: true })
  hasApiKey: boolean;

  @ApiPropertyOptional({ example: 'gpt-4.1-mini' })
  chatModel?: string | null;

  @ApiPropertyOptional({ example: 'text-embedding-3-small' })
  embeddingModel?: string | null;

  @ApiPropertyOptional({ example: 'bge-reranker-v2-m3' })
  rerankModel?: string | null;

  @ApiPropertyOptional({ example: 'whisper-1' })
  sttModel?: string | null;

  @ApiPropertyOptional({ example: 'tts-1' })
  ttsModel?: string | null;

  @ApiProperty({ example: {} })
  settings: Record<string, unknown>;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  updatedAt: Date;
}
