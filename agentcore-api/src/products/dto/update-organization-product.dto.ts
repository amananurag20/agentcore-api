import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateOrganizationProductDto {
  @ApiProperty({ enum: ['enabled', 'disabled'], example: 'enabled' })
  @IsString()
  @IsIn(['enabled', 'disabled'])
  status: 'enabled' | 'disabled';

  @ApiPropertyOptional({ example: {} })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}
