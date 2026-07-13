import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import {
  PRODUCT_KEYS,
  type ProductKey,
} from '../../common/auth/product-access.types';

export class UploadKnowledgeFileDto {
  @ApiPropertyOptional({
    description: 'Super admins may upload sources for another organization.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Restaurant Menu', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 4, default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  sensitivityLevel?: number;

  @ApiPropertyOptional({ enum: PRODUCT_KEYS, isArray: true })
  @Transform(({ value }: { value: string | string[] }) =>
    Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @IsIn(PRODUCT_KEYS, { each: true })
  @IsOptional()
  productVisibility?: ProductKey[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  folderId?: string;

  @ApiPropertyOptional({ type: String, isArray: true })
  @Transform(({ value }: { value: string | string[] }) =>
    Array.isArray(value)
      ? value
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({
    description: 'JSON object string stored with the source.',
    example: '{"locale":"en"}',
  })
  @IsString()
  @IsOptional()
  metadata?: string;
}
