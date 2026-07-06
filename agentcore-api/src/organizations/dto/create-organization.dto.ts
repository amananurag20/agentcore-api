import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Inc', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

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
}
