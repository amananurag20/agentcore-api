import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { LeadStatusDto } from './list-leads.dto';

export class UpdateLeadDto {
  @ApiPropertyOptional({ enum: LeadStatusDto })
  @IsEnum(LeadStatusDto)
  @IsOptional()
  status?: LeadStatusDto;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string | null;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  email?: string | null;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(40)
  @IsOptional()
  phone?: string | null;

  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(5000)
  @IsOptional()
  notes?: string | null;

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];
}
