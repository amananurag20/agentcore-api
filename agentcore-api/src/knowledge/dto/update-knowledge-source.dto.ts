import { PartialType } from '@nestjs/swagger';
import { CreateKnowledgeSourceDto } from './create-knowledge-source.dto';

export class UpdateKnowledgeSourceDto extends PartialType(
  CreateKnowledgeSourceDto,
) {}
