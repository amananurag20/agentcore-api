import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateCustomerChatConversationDto {
  @ApiPropertyOptional({
    description: 'Super admins may create conversations for another org.',
    example: 'org_demo',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'visitor_123' })
  @IsString()
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ example: 'Ada Visitor' })
  @IsString()
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ example: { pageUrl: 'https://example.com/pricing' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
