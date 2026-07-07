import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateIf,
} from 'class-validator';

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
