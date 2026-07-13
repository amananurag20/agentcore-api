import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class InternalMemoryRetrieveDto {
  @ApiProperty({ enum: PRODUCT_KEYS })
  @IsString()
  @IsIn(PRODUCT_KEYS)
  product: ProductKey;

  @ApiProperty({ minLength: 2 })
  @IsString()
  @MinLength(2)
  query: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 8 })
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  topK?: number;

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  categoryHint?: string[];
}
