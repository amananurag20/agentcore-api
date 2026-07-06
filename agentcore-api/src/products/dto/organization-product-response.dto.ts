import { ApiProperty } from '@nestjs/swagger';
import { ProductResponseDto } from './product-response.dto';

export class OrganizationProductResponseDto {
  @ApiProperty({ example: '2d02d2da-c1bb-460b-af4e-a90be2b483de' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  organizationId: string;

  @ApiProperty({ enum: ['enabled', 'disabled'], example: 'enabled' })
  status: 'enabled' | 'disabled';

  @ApiProperty({ example: {} })
  config: Record<string, unknown>;

  @ApiProperty({ type: ProductResponseDto })
  product: ProductResponseDto;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  updatedAt: Date;
}
