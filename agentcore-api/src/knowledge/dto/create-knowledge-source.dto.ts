import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsArray,
  IsBoolean,
  IsInt,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  PRODUCT_KEYS,
  type ProductKey,
} from '../../common/auth/product-access.types';

export class CreateKnowledgeSourceDto {
  @ApiPropertyOptional({
    description: 'Super admins may create sources for another organization.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({
    enum: ['website_url', 'uploaded_file', 'text', 'faq'],
    example: 'website_url',
  })
  @IsString()
  @IsIn(['website_url', 'uploaded_file', 'text', 'faq'])
  type: 'website_url' | 'uploaded_file' | 'text' | 'faq';

  @ApiPropertyOptional({
    enum: ['pending', 'processing', 'ready', 'failed'],
    example: 'pending',
  })
  @IsString()
  @IsIn(['pending', 'processing', 'ready', 'failed'])
  @IsOptional()
  status?: 'pending' | 'processing' | 'ready' | 'failed';

  @ApiProperty({ example: 'Company Website', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 4, default: 0 })
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  sensitivityLevel?: number;

  @ApiPropertyOptional({ enum: PRODUCT_KEYS, isArray: true })
  @IsArray()
  @IsIn(PRODUCT_KEYS, { each: true })
  @IsOptional()
  productVisibility?: ProductKey[];

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isQuarantined?: boolean;

  @ApiPropertyOptional({ example: 'https://example.com' })
  @ValidateIf((input: CreateKnowledgeSourceDto) => input.type === 'website_url')
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiPropertyOptional({ example: 'menu.pdf' })
  @ValidateIf(
    (input: CreateKnowledgeSourceDto) => input.type === 'uploaded_file',
  )
  @IsString()
  fileName?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsString()
  @IsOptional()
  mimeType?: string;

  @ApiPropertyOptional({ example: 'Business hours are 9am to 6pm.' })
  @ValidateIf(
    (input: CreateKnowledgeSourceDto) =>
      input.type === 'text' || input.type === 'faq',
  )
  @IsString()
  @MinLength(1)
  rawText?: string;

  @ApiPropertyOptional({ example: { locale: 'en' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
