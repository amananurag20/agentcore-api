import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  Max,
  Min,
  IsInt,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../../common/auth/authenticated-request';
import { ProductAccessDto } from './product-access.dto';

export class CreateUserDto {
  @ApiProperty({ example: 'Support Agent', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ example: 'agent@agentcore.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPassword@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({
    description:
      'Organization id. Super admins may set this; org admins are always scoped to their own organization.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  orgId?: string;

  @ApiPropertyOptional({
    enum: ['super_admin', 'org_admin', 'product_admin', 'agent', 'user'],
    isArray: true,
    example: ['agent'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  roles?: UserRole[];

  @ApiPropertyOptional({ minimum: 0, maximum: 4, default: 0 })
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  clearanceLevel?: number;

  @ApiPropertyOptional({ type: ProductAccessDto, isArray: true })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAccessDto)
  @IsOptional()
  productAccess?: ProductAccessDto[];
}
