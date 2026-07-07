import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmbeddingsService } from '../ai/embeddings.service';
import { toPgVector } from '../ai/vector-sql';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionJobData } from './knowledge-ingestion.types';
import { TextChunkerService } from './text-chunker.service';

@Injectable()
export class KnowledgeIngestionService {
  constructor(
    private readonly chunker: TextChunkerService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly prisma: PrismaService,
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

      if (!source.rawText && source.type !== 'text' && source.type !== 'faq') {
        await this.markUnsupportedSource(data.sourceId, source.type);
        return;
      }

      const document =
        source.documents[0] ??
        (await this.prisma.knowledgeDocument.create({
          data: {
            organizationId: source.organizationId,
            sourceId: source.id,
            title: source.name,
            uri: source.url,
            contentText: source.rawText,
            metadata: this.toJsonObject(source.metadata),
          },
        }));

      const chunks = this.chunker.chunk(
        document.contentText ?? source.rawText ?? '',
      );

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
            chunkIndex: index,
            content: chunk.content,
            charCount: chunk.charCount,
            tokenEstimate: chunk.tokenEstimate,
            metadata: this.toJsonObject({
              sourceType: source.type,
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

      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'ready',
          errorMessage: null,
          lastIngestedAt: new Date(),
          metadata: this.mergeMetadata(source.metadata, {
            chunkCount: chunks.length,
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

  private async markUnsupportedSource(sourceId: string, sourceType: string) {
    await this.prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: {
        status: 'failed',
        errorMessage: `${sourceType} ingestion is not implemented yet`,
      },
    });
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
