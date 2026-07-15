export interface KnowledgeIngestionJobData {
  runId?: string;
  organizationId: string;
  sourceId: string;
  reason:
    | 'source_created'
    | 'file_uploaded'
    | 'manual_retry'
    | 'scheduled_recrawl'
    | 'embedding_model_changed';
}

export class KnowledgeIngestionCancelledError extends Error {
  constructor() {
    super('Knowledge ingestion was cancelled');
    this.name = 'KnowledgeIngestionCancelledError';
  }
}
