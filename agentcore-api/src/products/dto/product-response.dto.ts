import { ApiProperty } from '@nestjs/swagger';

export class ProductResponseDto {
  @ApiProperty({ example: '98fb4b79-d4c2-48bb-9e83-3f31c588a24f' })
  id: string;

  @ApiProperty({
    enum: [
      'customer_chat',
      'appointment_booking',
      'whatsapp_assistant',
      'voice_receptionist',
    ],
    example: 'customer_chat',
  })
  key:
    | 'customer_chat'
    | 'appointment_booking'
    | 'whatsapp_assistant'
    | 'voice_receptionist';

  @ApiProperty({ example: 'Customer Chat' })
  name: string;

  @ApiProperty({
    example: 'AI-powered customer chat with grounded answers and handoff.',
  })
  description: string;

  @ApiProperty({ enum: ['active', 'inactive'], example: 'active' })
  status: 'active' | 'inactive';

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-07-06T06:00:00.000Z' })
  updatedAt: Date;
}
