import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';

@Injectable()
export class KnowledgeLifecycleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeLifecycleService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastOcrCacheCleanupAt = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queue: KnowledgeIngestionQueueService,
  ) {}

  onModuleInit() {
    if (!this.queue.isEnabled()) return;
    const intervalMs =
      this.configService.get<number>('KNOWLEDGE_LIFECYCLE_INTERVAL_MS') ??
      60_000;
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const due = await this.prisma.knowledgeSource.findMany({
        where: {
          type: 'website_url',
          recrawlIntervalHours: { not: null },
          nextCrawlAt: { lte: now },
          status: { in: ['ready', 'failed'] },
        },
        take: 100,
        orderBy: { nextCrawlAt: 'asc' },
      });
      let queued = 0;
      for (const source of due) {
        const claimed = await this.prisma.knowledgeSource.updateMany({
          where: { id: source.id, nextCrawlAt: source.nextCrawlAt },
          data: {
            status: 'pending',
            nextCrawlAt: new Date(
              now.getTime() + (source.recrawlIntervalHours ?? 24) * 60 * 60_000,
            ),
          },
        });
        if (!claimed.count) continue;
        await this.queue.enqueue({
          organizationId: source.organizationId,
          sourceId: source.id,
          reason: 'scheduled_recrawl',
        });
        queued += 1;
      }
      if (queued) this.logger.log(`Queued ${queued} website recrawls`);
      await this.cleanupOcrCache(now);
    } catch (error) {
      this.logger.error(
        `Knowledge lifecycle scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async cleanupOcrCache(now: Date) {
    const cleanupIntervalMs = 24 * 60 * 60_000;
    if (now.getTime() - this.lastOcrCacheCleanupAt < cleanupIntervalMs) return;
    const retentionDays =
      this.configService.get<number>('KNOWLEDGE_OCR_CACHE_RETENTION_DAYS') ??
      90;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
    const deleted = await this.prisma.knowledgeOcrPageCache.deleteMany({
      where: { lastAccessedAt: { lt: cutoff } },
    });
    this.lastOcrCacheCleanupAt = now.getTime();
    if (deleted.count) {
      this.logger.log(
        `Removed ${deleted.count} expired OCR page cache entries`,
      );
    }
  }
}
