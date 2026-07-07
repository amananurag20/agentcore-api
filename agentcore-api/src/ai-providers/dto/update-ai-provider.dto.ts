import { PartialType } from '@nestjs/swagger';
import { CreateAIProviderDto } from './create-ai-provider.dto';

export class UpdateAIProviderDto extends PartialType(CreateAIProviderDto) {}
