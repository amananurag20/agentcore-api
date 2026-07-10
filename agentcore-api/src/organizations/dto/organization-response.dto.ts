import { ApiProperty } from '@nestjs/swagger';

export class OrganizationResponseDto {
  @ApiProperty({ example: 'org_demo' })
  id: string;

  @ApiProperty({ example: 'Demo Organization' })
  name: string;

  @ApiProperty({ example: 'demo-organization' })
  slug: string;

  @ApiProperty({ nullable: true, example: 'operations@acme.com' })
  contactEmail: string | null;

  @ApiProperty({ nullable: true, example: '+1 555 0100' })
  contactPhone: string | null;

  @ApiProperty({ enum: ['active', 'inactive', 'suspended'], example: 'active' })
  status: 'active' | 'inactive' | 'suspended';

  @ApiProperty({
    enum: ['free', 'starter', 'pro', 'enterprise'],
    example: 'free',
  })
  plan: 'free' | 'starter' | 'pro' | 'enterprise';

  @ApiProperty({ enum: ['local', 'saas'], example: 'saas' })
  deploymentMode: 'local' | 'saas';

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  updatedAt: Date;
}
