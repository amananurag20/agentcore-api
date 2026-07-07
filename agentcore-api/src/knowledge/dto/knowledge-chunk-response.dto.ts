import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KnowledgeChunkResponseDto {
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

  @ApiProperty({ example: 34 })
  charCount: number;

  @ApiProperty({ example: 9 })
  tokenEstimate: number;

  @ApiProperty({ example: {} })
  metadata: Record<string, unknown>;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  updatedAt: Date;
}
