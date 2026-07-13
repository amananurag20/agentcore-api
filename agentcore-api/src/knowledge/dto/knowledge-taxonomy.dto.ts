import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateKnowledgeCategoryDto {
  @ApiProperty({ minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;
}

export class CreateKnowledgeFolderDto {
  @ApiProperty({ minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;
}

export class UpdateKnowledgeCategoryDto {
  @ApiProperty({ minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;
}

export class UpdateKnowledgeFolderDto {
  @ApiPropertyOptional({ minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  parentId?: string | null;
}
