import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductAccessDto } from '../../users/dto/product-access.dto';

export class CreateCustomRoleDto {
  @ApiProperty({ example: 'Front Desk', minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'Handles customer requests and bookings.' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiProperty({ minimum: 0, maximum: 4, example: 1 })
  @IsInt()
  @Min(0)
  @Max(4)
  clearanceLevel: number;

  @ApiProperty({ type: ProductAccessDto, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ProductAccessDto)
  productAccess: ProductAccessDto[];

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isTemplate?: boolean;

  @ApiPropertyOptional({
    description: 'Required for a super admin acting across tenants.',
  })
  @IsString()
  @IsOptional()
  orgId?: string;
}

export class UpdateCustomRoleDto {
  @ApiPropertyOptional({ minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 4 })
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  clearanceLevel?: number;

  @ApiPropertyOptional({ type: ProductAccessDto, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ProductAccessDto)
  @IsOptional()
  productAccess?: ProductAccessDto[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
