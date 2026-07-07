import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpdateCustomerChatWidgetConfigDto {
  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'Hi! How can I help you today?' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  greetingText?: string;

  @ApiPropertyOptional({
    example: ['https://example.com', 'https://www.example.com'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedDomains?: string[];

  @ApiPropertyOptional({ example: { primaryColor: '#111827' } })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
