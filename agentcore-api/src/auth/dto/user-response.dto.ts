import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../common/auth/authenticated-request';

export class UserResponseDto {
  @ApiProperty({ example: '4dd9bd6a-27d3-4bd1-a8f8-3b602f3b87f4' })
  id: string;

  @ApiProperty({ example: 'org_demo' })
  orgId: string;

  @ApiProperty({ example: 'admin@agentcore.local' })
  email: string;

  @ApiProperty({ example: 'AgentCore Admin' })
  name: string;

  @ApiProperty({
    enum: ['super_admin', 'org_admin', 'product_admin', 'agent', 'user'],
    isArray: true,
    example: ['super_admin', 'org_admin'],
  })
  roles: UserRole[];

  @ApiProperty({ example: 2, minimum: 0, maximum: 4 })
  clearanceLevel: number;

  @ApiProperty({ isArray: true, type: Object })
  productAccess: Array<{
    productKey: string;
    canUse: boolean;
    canConfigure: boolean;
    canManageAgents: boolean;
  }>;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  updatedAt: Date;
}
