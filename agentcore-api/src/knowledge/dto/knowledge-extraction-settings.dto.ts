import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsBoundedJson } from '../../common/validation/is-bounded-json.decorator';

export class CreateKnowledgeOcrProviderDto {
  @ApiPropertyOptional({ description: 'Available to super admins only.' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Local Tesseract' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({
    enum: [
      'local_tesseract',
      'aws_textract',
      'google_document_ai',
      'azure_document_intelligence',
      'custom',
    ],
  })
  @IsString()
  @IsIn([
    'local_tesseract',
    'aws_textract',
    'google_document_ai',
    'azure_document_intelligence',
    'custom',
  ])
  provider:
    | 'local_tesseract'
    | 'aws_textract'
    | 'google_document_ai'
    | 'azure_document_intelligence'
    | 'custom';

  @ApiPropertyOptional({ enum: ['active', 'inactive'], default: 'active' })
  @IsString()
  @IsIn(['active', 'inactive'])
  @IsOptional()
  status?: 'active' | 'inactive';

  @ApiProperty({ example: 'http://ocr-tesseract:8080/ocr' })
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2048)
  endpoint: string;

  @ApiPropertyOptional({ description: 'Write-only provider credential.' })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional({ example: { language: 'eng' } })
  @IsObject()
  @IsBoundedJson({ maxBytes: 8 * 1024, maxEntries: 50 })
  @IsOptional()
  settings?: Record<string, unknown>;
}

export class UpdateKnowledgeOcrProviderDto extends PartialType(
  CreateKnowledgeOcrProviderDto,
) {}

export class UpdateKnowledgeExtractionSettingsDto {
  @ApiPropertyOptional({ description: 'Available to super admins only.' })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ enum: ['disabled', 'fallback', 'always'] })
  @IsString()
  @IsIn(['disabled', 'fallback', 'always'])
  @IsOptional()
  ocrMode?: 'disabled' | 'fallback' | 'always';

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  primaryOcrProviderId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  fallbackOcrProviderId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  embeddingProviderId?: string | null;

  @IsInt()
  @Min(0)
  @Max(10_000)
  @IsOptional()
  nativeTextMinCharacters?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  nativeTextMinAlphanumericRatio?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  ocrMinConfidence?: number;

  @IsInt()
  @Min(1_000)
  @Max(300_000)
  @IsOptional()
  ocrTimeoutMs?: number;

  @IsInt()
  @Min(0)
  @Max(5)
  @IsOptional()
  ocrMaxRetries?: number;

  @IsInt()
  @Min(1)
  @Max(32)
  @IsOptional()
  ocrPageConcurrency?: number;

  @IsInt()
  @Min(800)
  @Max(4_000)
  @IsOptional()
  ocrRenderWidth?: number;

  @IsInt()
  @Min(1)
  @Max(20_000)
  @IsOptional()
  maxPdfPages?: number;

  @IsInt()
  @Min(1_000)
  @Max(50_000_000)
  @IsOptional()
  maxExtractedCharacters?: number;

  @IsObject()
  @IsBoundedJson({ maxBytes: 8 * 1024, maxEntries: 50 })
  @IsOptional()
  settings?: Record<string, unknown>;
}
