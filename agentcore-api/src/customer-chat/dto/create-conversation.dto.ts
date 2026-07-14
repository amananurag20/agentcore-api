import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsBoundedJson } from '../../common/validation/is-bounded-json.decorator';

export class CreateCustomerChatConversationDto {
  @ApiPropertyOptional({
    description: 'Super admins may create conversations for another org.',
    example: 'org_demo',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'visitor_123' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ example: 'Ada Visitor' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ example: { pageUrl: 'https://example.com/pricing' } })
  @IsObject()
  @IsBoundedJson()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
