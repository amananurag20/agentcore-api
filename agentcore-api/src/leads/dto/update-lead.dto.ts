import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { LeadStatusDto } from './list-leads.dto';

export class UpdateLeadDto {
  @ApiPropertyOptional({ enum: LeadStatusDto })
  @IsEnum(LeadStatusDto)
  @IsOptional()
  status?: LeadStatusDto;

  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  email?: string;

  @IsString()
  @MaxLength(40)
  @IsOptional()
  phone?: string;

  @IsString()
  @MaxLength(5000)
  @IsOptional()
  notes?: string;

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];
}
