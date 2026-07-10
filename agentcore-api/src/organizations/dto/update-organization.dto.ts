import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Inc', minLength: 2 })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'operations@acme.com' })
  @IsEmail()
  @IsOptional()
  contactEmail?: string;

  @ApiPropertyOptional({ example: '+1 555 0100' })
  @IsString()
  @IsOptional()
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'acme-inc' })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'suspended'] })
  @IsString()
  @IsOptional()
  @IsIn(['active', 'inactive', 'suspended'])
  status?: 'active' | 'inactive' | 'suspended';

  @ApiPropertyOptional({ enum: ['free', 'starter', 'pro', 'enterprise'] })
  @IsString()
  @IsOptional()
  @IsIn(['free', 'starter', 'pro', 'enterprise'])
  plan?: 'free' | 'starter' | 'pro' | 'enterprise';

  @ApiPropertyOptional({ enum: ['local', 'saas'] })
  @IsString()
  @IsOptional()
  @IsIn(['local', 'saas'])
  deploymentMode?: 'local' | 'saas';
}
