export interface KnowledgeIngestionJobData {
  organizationId: string;
  sourceId: string;
  reason:
    'source_created' | 'file_uploaded' | 'manual_retry' | 'scheduled_recrawl';
}
