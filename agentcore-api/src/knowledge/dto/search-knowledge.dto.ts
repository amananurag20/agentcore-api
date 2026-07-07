import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class SearchKnowledgeDto {
  @ApiProperty({ example: 'What are the business hours?', minLength: 2 })
  @IsString()
  @MinLength(2)
  query: string;

  @ApiPropertyOptional({ example: 'f7a0297b-15de-4d8b-9362-9d4ef9eb3ef0' })
  @IsString()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional({ example: 5, default: 5 })
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  limit?: number;
}
