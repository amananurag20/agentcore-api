import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../../common/auth/authenticated-request';
import { ProductAccessDto } from './product-access.dto';

export class UpdateUserRolesDto {
  @ApiProperty({
    enum: ['super_admin', 'org_admin', 'product_admin', 'agent', 'user'],
    isArray: true,
    example: ['agent'],
  })
  @IsArray()
  @ArrayNotEmpty()
  roles: UserRole[];

  @ApiProperty({ minimum: 0, maximum: 4, required: false })
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  clearanceLevel?: number;

  @ApiProperty({ type: ProductAccessDto, isArray: true, required: false })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAccessDto)
  @IsOptional()
  productAccess?: ProductAccessDto[];

  @ApiProperty({ type: String, isArray: true, required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  customRoleIds?: string[];
}
