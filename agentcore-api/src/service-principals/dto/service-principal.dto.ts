import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import {
  PRODUCT_KEYS,
  type ProductKey,
} from '../../common/auth/product-access.types';

export class CreateServicePrincipalDto {
  @ApiProperty({ example: 'Customer Chat runtime' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ enum: PRODUCT_KEYS })
  @IsString()
  @IsIn(PRODUCT_KEYS)
  productKey: ProductKey;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  orgId?: string;
}

export class UpdateServicePrincipalStatusDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}

export class IssueServiceTokenDto {
  @ApiProperty()
  @IsString()
  clientId: string;

  @ApiProperty()
  @IsString()
  @MinLength(32)
  clientSecret: string;

  @ApiPropertyOptional({
    description:
      'Optional human access token whose current server-side clearance is forwarded.',
  })
  @IsString()
  @IsOptional()
  forwardedAccessToken?: string;
}
