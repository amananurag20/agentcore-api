import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeIngestionJobData } from './knowledge-ingestion.types';

@Injectable()
export class KnowledgeAlertService {
  private readonly logger = new Logger(KnowledgeAlertService.name);

  constructor(private readonly configService: ConfigService) {}

  async ingestionFailed(data: KnowledgeIngestionJobData, error: Error) {
    const url = this.configService.get<string>('KNOWLEDGE_ALERT_WEBHOOK_URL');
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'knowledge.ingestion.failed',
          occurredAt: new Date().toISOString(),
          organizationId: data.organizationId,
          sourceId: data.sourceId,
          reason: data.reason,
          error: error.message,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        this.logger.warn(`Knowledge alert webhook returned ${response.status}`);
    } catch (alertError) {
      this.logger.warn(
        `Knowledge alert webhook failed: ${alertError instanceof Error ? alertError.message : String(alertError)}`,
      );
    }
  }
}
