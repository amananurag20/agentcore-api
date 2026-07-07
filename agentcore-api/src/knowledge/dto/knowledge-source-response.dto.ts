import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KnowledgeSourceResponseDto {
  @ApiProperty({ example: 'f7a0297b-15de-4d8b-9362-9d4ef9eb3ef0' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiProperty({
    enum: ['website_url', 'uploaded_file', 'text', 'faq'],
    example: 'website_url',
  })
  type: 'website_url' | 'uploaded_file' | 'text' | 'faq';

  @ApiProperty({
    enum: ['pending', 'processing', 'ready', 'failed'],
    example: 'pending',
  })
  status: 'pending' | 'processing' | 'ready' | 'failed';

  @ApiProperty({ example: 'Company Website' })
  name: string;

  @ApiPropertyOptional({ example: 'https://example.com' })
  url?: string | null;

  @ApiPropertyOptional({ example: 'menu.pdf' })
  fileName?: string | null;

  @ApiPropertyOptional({ example: 'application/pdf' })
  mimeType?: string | null;

  @ApiPropertyOptional({ enum: ['s3', 'r2', 'minio'], example: 's3' })
  storageProvider?: 's3' | 'r2' | 'minio' | null;

  @ApiPropertyOptional({ example: 'agentcore-knowledge' })
  storageBucket?: string | null;

  @ApiPropertyOptional({
    example: 'knowledge/org_demo/abc123-menu.pdf',
  })
  storageKey?: string | null;

  @ApiPropertyOptional({ example: 248192 })
  fileSizeBytes?: number | null;

  @ApiPropertyOptional({
    example: '94f6f6b6f0e5ed7f958b94f4a9d8d508f003c41d',
  })
  checksumSha256?: string | null;

  @ApiPropertyOptional({ example: 'Business hours are 9am to 6pm.' })
  rawText?: string | null;

  @ApiProperty({ example: {} })
  metadata: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'Could not fetch the website URL.' })
  errorMessage?: string | null;

  @ApiPropertyOptional({ example: '2026-07-07T06:00:00.000Z' })
  lastIngestedAt?: Date | null;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-07T06:00:00.000Z' })
  updatedAt: Date;
}
