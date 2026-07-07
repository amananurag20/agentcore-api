import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KnowledgeSearchResultDto {
  @ApiProperty({ example: 'f2fd8f8f-f871-4506-a326-6bfd67fd1519' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiPropertyOptional({
    example: 'f7a0297b-15de-4d8b-9362-9d4ef9eb3ef0',
  })
  sourceId?: string | null;

  @ApiProperty({ example: 'a9e2d9e6-1b50-4967-ae67-495a81f22099' })
  documentId: string;

  @ApiProperty({ example: 0 })
  chunkIndex: number;

  @ApiProperty({ example: 'Business hours are 9am to 6pm.' })
  content: string;

  @ApiProperty({ example: 0.82 })
  score: number;

  @ApiPropertyOptional({ example: 'text-embedding-3-small' })
  embeddingModel?: string | null;

  @ApiPropertyOptional({ enum: ['openai', 'anthropic', 'local', 'custom'] })
  embeddingProvider?: string | null;
}
