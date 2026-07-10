import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../../common/auth/authenticated-request';
import { ProductAccessDto } from '../../users/dto/product-access.dto';

export class CreateInviteDto {
  @ApiProperty({ example: 'agent@agentcore.local' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'Support Agent', minLength: 2 })
  @IsString()
  @MinLength(2)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description:
      'Organization id. Super admins may set this; org admins are scoped to their own organization.',
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

  @ApiPropertyOptional({ minimum: 0, maximum: 4 })
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
