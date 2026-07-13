import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeDocument, KnowledgeSource, Prisma } from '@prisma/client';
import { EmbeddingsService } from '../ai/embeddings.service';
import { AuditService } from '../audit/audit.service';
import { toPgVector } from '../ai/vector-sql';
import { PrismaService } from '../prisma/prisma.service';
import { S3StorageService } from '../storage/s3-storage.service';
import { KnowledgeFileExtractorService } from './knowledge-file-extractor.service';
import { KnowledgeClassificationService } from './knowledge-classification.service';
import { KnowledgeIngestionJobData } from './knowledge-ingestion.types';
import { TextChunkerService } from './text-chunker.service';
import { UrlScraperService } from './url-scraper.service';

@Injectable()
export class KnowledgeIngestionService {
  constructor(
    private readonly chunker: TextChunkerService,
    private readonly auditService: AuditService,
    private readonly classifier: KnowledgeClassificationService,
    private readonly configService: ConfigService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly fileExtractor: KnowledgeFileExtractorService,
    private readonly prisma: PrismaService,
    private readonly storageService: S3StorageService,
    private readonly urlScraper: UrlScraperService,
  ) {}

  async ingestSource(data: KnowledgeIngestionJobData) {
    const source = await this.prisma.knowledgeSource.findUnique({
      where: { id: data.sourceId },
      include: { documents: true },
    });

    if (!source) {
      throw new NotFoundException('Knowledge source not found');
    }

    try {
      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'processing',
          errorMessage: null,
          metadata: this.mergeMetadata(source.metadata, {
            ingestionReason: data.reason,
            ingestionStartedAt: new Date().toISOString(),
          }),
        },
      });

      if (
        source.type !== 'website_url' &&
        source.type !== 'uploaded_file' &&
        !source.rawText &&
        source.type !== 'text' &&
        source.type !== 'faq'
      ) {
        await this.markUnsupportedSource(data.sourceId, source.type);
        return;
      }

      const documents = await this.prepareDocuments(source);
      const effectiveSource = await this.classifyIfNeeded(source, documents);
      let totalChunks = 0;

      for (const document of documents) {
        const chunks = this.chunker.chunk(document.contentText ?? '');

        await this.prisma.knowledgeChunk.deleteMany({
          where: { documentId: document.id },
        });

        for (const [index, chunk] of chunks.entries()) {
          const embedding = await this.embeddingsService.embedText({
            organizationId: source.organizationId,
            text: chunk.content,
          });
          const createdChunk = await this.prisma.knowledgeChunk.create({
            data: {
              organizationId: source.organizationId,
              sourceId: source.id,
              documentId: document.id,
              sensitivityLevel: effectiveSource.sensitivityLevel,
              productVisibility: effectiveSource.productVisibility,
              categories: effectiveSource.categories,
              isQuarantined: effectiveSource.isQuarantined,
              chunkIndex: index,
              content: chunk.content,
              charCount: chunk.charCount,
              tokenEstimate: chunk.tokenEstimate,
              metadata: this.toJsonObject({
                sourceType: source.type,
                uri: document.uri,
              }),
              embeddingModel: embedding.model,
              embeddingProvider:
                embedding.provider === 'local' ? undefined : embedding.provider,
              embeddedAt: new Date(),
            },
          });

          await this.prisma.$executeRaw`
            UPDATE "knowledge_chunks"
            SET "embedding" = ${toPgVector(embedding.vector)}::vector
            WHERE "id" = ${createdChunk.id}
          `;
        }

        totalChunks += chunks.length;
      }

      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'ready',
          errorMessage: null,
          lastIngestedAt: new Date(),
          metadata: this.mergeMetadata(effectiveSource.metadata, {
            chunkCount: totalChunks,
            documentCount: documents.length,
            ingestionCompletedAt: new Date().toISOString(),
            ingestionReason: data.reason,
          }),
        },
      });
    } catch (error) {
      await this.prisma.knowledgeSource.update({
        where: { id: data.sourceId },
        data: {
          status: 'failed',
          errorMessage:
            error instanceof Error
              ? error.message
              : 'Knowledge ingestion failed',
        },
      });

      throw error;
    }
  }

  private async classifyIfNeeded(
    source: KnowledgeSource,
    documents: KnowledgeDocument[],
  ): Promise<KnowledgeSource> {
    if (source.levelSource === 'manual') return source;

    const classification = await this.classifier.classify({
      organizationId: source.organizationId,
      title: source.name,
      text: documents
        .map((document) => document.contentText ?? '')
        .join('\n\n')
        .slice(0, 24_000),
    });
    const quarantineThreshold = this.configService.get<number>(
      'KNOWLEDGE_QUARANTINE_LEVEL',
      3,
    );
    const categories = [
      ...new Set([...source.categories, ...classification.categories]),
    ];
    const sourceMetadata = this.toRecord(source.metadata);
    const isApproved = Boolean(sourceMetadata.classificationApprovedAt);
    const isQuarantined =
      classification.level >= quarantineThreshold && !isApproved;
    const metadata = this.mergeMetadata(source.metadata, {
      classification: {
        suggestedLevel: classification.level,
        suggestedCategories: classification.categories,
        rationale: classification.rationale,
        classifier: classification.classifier,
        classifiedAt: new Date().toISOString(),
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeCategory.createMany({
        data: classification.categories.map((name) => ({
          organizationId: source.organizationId,
          name,
          slug: name,
          isSystem: true,
        })),
        skipDuplicates: true,
      });
      await tx.knowledgeDocument.updateMany({
        where: { sourceId: source.id },
        data: {
          sensitivityLevel: classification.level,
          categories,
          isQuarantined,
        },
      });
      return tx.knowledgeSource.update({
        where: { id: source.id },
        data: {
          sensitivityLevel: classification.level,
          categories,
          isQuarantined,
          metadata,
        },
      });
    });

    await this.auditService.record({
      actor: null,
      organizationId: source.organizationId,
      action: 'knowledge_source.classified',
      entityType: 'knowledge_source',
      entityId: source.id,
      metadata: {
        suggestedLevel: classification.level,
        categories,
        rationale: classification.rationale,
        classifier: classification.classifier,
        quarantined: isQuarantined,
      },
    });
    return updated;
  }

  private async markUnsupportedSource(sourceId: string, sourceType: string) {
    await this.prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: {
        status: 'failed',
        errorMessage: `${sourceType} ingestion is not implemented yet`,
      },
    });
  }

  private async prepareDocuments(
    source: KnowledgeSource & { documents: KnowledgeDocument[] },
  ): Promise<KnowledgeDocument[]> {
    if (source.type === 'website_url') {
      if (!source.url) {
        throw new Error('Website URL source is missing a URL');
      }

      const pages = await this.urlScraper.scrape(source.url);

      await this.prisma.knowledgeDocument.deleteMany({
        where: { sourceId: source.id },
      });

      return Promise.all(
        pages.map((page) =>
          this.prisma.knowledgeDocument.create({
            data: {
              organizationId: source.organizationId,
              sourceId: source.id,
              title: page.title,
              sensitivityLevel: source.sensitivityLevel,
              productVisibility: source.productVisibility,
              categories: source.categories,
              isQuarantined: source.isQuarantined,
              uri: page.url,
              contentText: page.text,
              metadata: this.toJsonObject({
                sourceType: source.type,
                scrapedAt: new Date().toISOString(),
                statusCode: page.statusCode,
              }),
            },
          }),
        ),
      );
    }

    if (source.type === 'uploaded_file') {
      if (!source.storageKey) {
        throw new Error('Uploaded file source is missing a storage key');
      }

      const fileBuffer = await this.storageService.getKnowledgeFile({
        bucket: source.storageBucket,
        key: source.storageKey,
      });
      const extracted = await this.fileExtractor.extract({
        buffer: fileBuffer,
        fileName: source.fileName,
        mimeType: source.mimeType,
      });

      await this.prisma.knowledgeDocument.deleteMany({
        where: { sourceId: source.id },
      });

      const document = await this.prisma.knowledgeDocument.create({
        data: {
          organizationId: source.organizationId,
          sourceId: source.id,
          title: source.fileName ?? source.name,
          sensitivityLevel: source.sensitivityLevel,
          productVisibility: source.productVisibility,
          categories: source.categories,
          isQuarantined: source.isQuarantined,
          uri: source.storageKey,
          contentText: extracted.text,
          metadata: this.toJsonObject({
            ...this.toRecord(source.metadata),
            ...extracted.metadata,
            sourceType: source.type,
            mimeType: source.mimeType,
            fileName: source.fileName,
            storageProvider: source.storageProvider,
            storageBucket: source.storageBucket,
            storageKey: source.storageKey,
            checksumSha256: source.checksumSha256,
            extractedAt: new Date().toISOString(),
          }),
        },
      });

      return [document];
    }

    const document =
      source.documents[0] ??
      (await this.prisma.knowledgeDocument.create({
        data: {
          organizationId: source.organizationId,
          sourceId: source.id,
          title: source.name,
          sensitivityLevel: source.sensitivityLevel,
          productVisibility: source.productVisibility,
          categories: source.categories,
          isQuarantined: source.isQuarantined,
          uri: source.url,
          contentText: source.rawText,
          metadata: this.toJsonObject(source.metadata),
        },
      }));

    if (!document.contentText?.trim()) {
      throw new Error('Knowledge source has no text content to ingest');
    }

    return [document];
  }

  private mergeMetadata(
    current: Prisma.JsonValue,
    updates: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    return {
      ...this.toRecord(current),
      ...updates,
    } as Prisma.InputJsonObject;
  }

  private toJsonObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
    return this.toRecord(value) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
