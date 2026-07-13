import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class ListKnowledgeSourcesDto {
  @IsString()
  @IsOptional()
  organizationId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 25;

  @IsString()
  @IsOptional()
  search?: string;

  @IsIn(['pending', 'processing', 'ready', 'failed'])
  @IsOptional()
  status?: 'pending' | 'processing' | 'ready' | 'failed';

  @IsIn(['website_url', 'uploaded_file', 'text', 'faq'])
  @IsOptional()
  type?: 'website_url' | 'uploaded_file' | 'text' | 'faq';

  @IsString()
  @IsOptional()
  folderId?: string;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  quarantined?: boolean;
}
