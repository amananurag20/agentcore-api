import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../common/auth/authenticated-request';

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
    enum: ['super_admin', 'org_admin', 'agent', 'user'],
    isArray: true,
    example: ['agent'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  roles?: UserRole[];
}
