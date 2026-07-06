import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray } from 'class-validator';
import { UserRole } from '../../common/auth/authenticated-request';

export class UpdateUserRolesDto {
  @ApiProperty({
    enum: ['super_admin', 'org_admin', 'agent', 'user'],
    isArray: true,
    example: ['agent'],
  })
  @IsArray()
  @ArrayNotEmpty()
  roles: UserRole[];
}
