import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum LeadStatusDto {
  new = 'new',
  contacted = 'contacted',
  qualified = 'qualified',
  converted = 'converted',
  disqualified = 'disqualified',
  archived = 'archived',
}

export enum LeadPriorityDto {
  low = 'low',
  medium = 'medium',
  high = 'high',
  hot = 'hot',
}

export class ListLeadsDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: LeadStatusDto })
  @IsEnum(LeadStatusDto)
  @IsOptional()
  status?: LeadStatusDto;

  @ApiPropertyOptional({ enum: LeadPriorityDto })
  @IsEnum(LeadPriorityDto)
  @IsOptional()
  priority?: LeadPriorityDto;

  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  minScore?: number;

  @ApiPropertyOptional({ enum: ['score', 'lastActivity'] })
  @IsIn(['score', 'lastActivity'])
  @IsOptional()
  sort?: 'score' | 'lastActivity';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  widgetConfigId?: string;

  @IsUUID('4')
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ enum: ['assigned', 'unassigned'] })
  @IsIn(['assigned', 'unassigned'])
  @IsOptional()
  assignment?: 'assigned' | 'unassigned';

  @ApiPropertyOptional({ enum: ['due', 'breached'] })
  @IsIn(['due', 'breached'])
  @IsOptional()
  sla?: 'due' | 'breached';

  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @Transform(({ value }) => Number(value ?? 25))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 25;
}
