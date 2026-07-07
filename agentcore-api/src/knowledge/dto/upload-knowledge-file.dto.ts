import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UploadKnowledgeFileDto {
  @ApiPropertyOptional({
    description: 'Super admins may upload sources for another organization.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiProperty({ example: 'Restaurant Menu', minLength: 2 })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({
    description: 'JSON object string stored with the source.',
    example: '{"locale":"en"}',
  })
  @IsString()
  @IsOptional()
  metadata?: string;
}
