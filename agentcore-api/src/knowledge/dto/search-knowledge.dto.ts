import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

export class SearchKnowledgeDto {
  @ApiProperty({ example: 'What are the business hours?', minLength: 2 })
  @IsString()
  @MinLength(2)
  query: string;

  @ApiPropertyOptional({ example: 'f7a0297b-15de-4d8b-9362-9d4ef9eb3ef0' })
  @IsString()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional({ example: 5, default: 5 })
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: PRODUCT_KEYS })
  @IsString()
  @IsIn(PRODUCT_KEYS)
  @IsOptional()
  productKey?: ProductKey;
}
