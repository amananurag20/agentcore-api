import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PRODUCT_KEYS,
  type ProductKey,
} from '../../common/auth/product-access.types';

export class FirstOrganizationAdminDto {
  @ApiProperty({ example: 'Acme Administrator', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPassword@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Inc', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'operations@acme.com' })
  @IsEmail()
  @IsOptional()
  contactEmail?: string;

  @ApiPropertyOptional({ example: '+1 555 0100' })
  @IsString()
  @IsOptional()
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 'acme-inc',
    description:
      'URL-safe organization slug. If omitted, one is generated from name.',
  })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @ApiPropertyOptional({
    enum: ['free', 'starter', 'pro', 'enterprise'],
    example: 'free',
  })
  @IsString()
  @IsOptional()
  @IsIn(['free', 'starter', 'pro', 'enterprise'])
  plan?: 'free' | 'starter' | 'pro' | 'enterprise';

  @ApiPropertyOptional({ enum: ['local', 'saas'], example: 'saas' })
  @IsString()
  @IsOptional()
  @IsIn(['local', 'saas'])
  deploymentMode?: 'local' | 'saas';

  @ApiProperty({ type: FirstOrganizationAdminDto })
  @ValidateNested()
  @Type(() => FirstOrganizationAdminDto)
  firstAdmin: FirstOrganizationAdminDto;

  @ApiPropertyOptional({ enum: PRODUCT_KEYS, isArray: true })
  @IsArray()
  @IsIn(PRODUCT_KEYS, { each: true })
  @IsOptional()
  enabledProducts?: ProductKey[];
}
