import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Acme Admin', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPassword@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ example: 'org_acme' })
  @IsString()
  @IsOptional()
  orgId?: string;

  @ApiPropertyOptional({
    example: 'Acme Inc',
    description: 'Organization name to create when orgId is not provided.',
  })
  @IsString()
  @MinLength(2)
  @IsOptional()
  orgName?: string;
}
