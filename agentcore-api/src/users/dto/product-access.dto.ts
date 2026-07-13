import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import {
  PRODUCT_KEYS,
  type ProductKey,
} from '../../common/auth/product-access.types';

export class ProductAccessDto {
  @ApiProperty({ enum: PRODUCT_KEYS, example: 'customer_chat' })
  @IsString()
  @IsIn(PRODUCT_KEYS)
  productKey: ProductKey;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  canUse?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  canConfigure?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  canManageAgents?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  canManageKnowledge?: boolean;
}
