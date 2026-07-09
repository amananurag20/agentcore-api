import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSource,
  Prisma,
} from '@prisma/client';
import { EmbeddingsService } from '../ai/embeddings.service';
import { toPgVector } from '../ai/vector-sql';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { KnowledgeIngestionQueueService } from '../knowledge-ingestion/knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from '../knowledge-ingestion/knowledge-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3StorageService } from '../storage/s3-storage.service';
import { CreateKnowledgeSourceDto } from './dto/create-knowledge-source.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { UpdateKnowledgeSourceDto } from './dto/update-knowledge-source.dto';
import { UploadKnowledgeFileDto } from './dto/upload-knowledge-file.dto';

type SafeKnowledgeSource = Omit<
  KnowledgeSource,
  'metadata' | 'fileSizeBytes'
> & {
  metadata: Record<string, unknown>;
  fileSizeBytes: number | null;
};

type SafeKnowledgeDocument = Omit<KnowledgeDocument, 'metadata'> & {
  metadata: Record<string, unknown>;
};

type SafeKnowledgeChunk = Omit<KnowledgeChunk, 'metadata'> & {
  metadata: Record<string, unknown>;
};

export interface KnowledgeSearchRow {
  id: string;
  organizationId: string;
  sourceId: string | null;
  documentId: string;
  chunkIndex: number;
  content: string;
  score: number;
  embeddingModel: string | null;
  embeddingProvider: string | null;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly auditService: AuditService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly ingestionQueueService: KnowledgeIngestionQueueService,
    private readonly prisma: PrismaService,
    private readonly storageService: S3StorageService,
  ) {}

  async listSources(
    currentUser: AuthenticatedUser,
  ): Promise<SafeKnowledgeSource[]> {
    const sources = await this.prisma.knowledgeSource.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { organizationId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
    });

    return sources.map((source) => this.toSafeSource(source));
  }

  async createSource(
    currentUser: AuthenticatedUser,
    input: CreateKnowledgeSourceDto,
  ): Promise<SafeKnowledgeSource> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );

    let source = await this.prisma.$transaction(async (tx) => {
      const createdSource = await tx.knowledgeSource.create({
        data: {
          organizationId,
          type: input.type,
          status: input.status ?? this.resolveInitialStatus(),
          name: input.name,
          url: input.url,
          fileName: input.fileName,
          mimeType: input.mimeType,
          rawText: input.rawText,
          metadata: this.toJsonObject(input.metadata),
        },
      });

      if (input.rawText) {
        await tx.knowledgeDocument.create({
          data: {
            organizationId,
            sourceId: createdSource.id,
            title: input.name,
            uri: input.url,
            contentText: input.rawText,
            metadata: this.toJsonObject(input.metadata),
          },
        });
      }

      return createdSource;
    });

    source = await this.enqueueIngestion(source, 'source_created');

    await this.auditService.record({
      actor: currentUser,
      organizationId: source.organizationId,
      action: 'knowledge_source.created',
      entityType: 'knowledge_source',
      entityId: source.id,
      metadata: {
        type: source.type,
        name: source.name,
      },
    });

    return this.toSafeSource(source);
  }

  async uploadFileSource(
    currentUser: AuthenticatedUser,
    input: UploadKnowledgeFileDto,
    file?: Express.Multer.File,
  ): Promise<SafeKnowledgeSource> {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    const metadata = this.parseMetadata(input.metadata);
    const storedObject = await this.storageService.uploadKnowledgeFile({
      organizationId,
      file,
    });

    let source = await this.prisma.knowledgeSource.create({
      data: {
        organizationId,
        type: 'uploaded_file',
        status: 'pending',
        name: input.name,
        fileName: file.originalname,
        mimeType: file.mimetype,
        storageProvider: storedObject.provider,
        storageBucket: storedObject.bucket,
        storageKey: storedObject.key,
        fileSizeBytes: storedObject.sizeBytes,
        checksumSha256: storedObject.checksumSha256,
        metadata: this.toJsonObject(metadata),
      },
    });

    source = await this.enqueueIngestion(source, 'file_uploaded');

    await this.auditService.record({
      actor: currentUser,
      organizationId: source.organizationId,
      action: 'knowledge_source.file_uploaded',
      entityType: 'knowledge_source',
      entityId: source.id,
      metadata: {
        name: source.name,
        fileName: source.fileName,
        storageProvider: source.storageProvider,
        storageBucket: source.storageBucket,
        storageKey: source.storageKey,
      },
    });

    return this.toSafeSource(source);
  }

  async getSourceById(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeKnowledgeSource> {
    const source = await this.findSourceForActor(currentUser, id);
    return this.toSafeSource(source);
  }

  async ingestSource(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeKnowledgeSource> {
    const source = await this.findSourceForActor(currentUser, id);

    await this.ingestionService.ingestSource({
      organizationId: source.organizationId,
      sourceId: source.id,
      reason: 'manual_retry',
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: source.organizationId,
      action: 'knowledge_source.ingested',
      entityType: 'knowledge_source',
      entityId: source.id,
      metadata: {
        reason: 'manual_retry',
      },
    });

    return this.getSourceById(currentUser, id);
  }

  async updateSource(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateKnowledgeSourceDto,
  ): Promise<SafeKnowledgeSource> {
    await this.findSourceForActor(currentUser, id);

    const source = await this.prisma.knowledgeSource.update({
      where: { id },
      data: {
        organizationId: input.organizationId
          ? this.resolveOrganizationId(currentUser, input.organizationId)
          : undefined,
        type: input.type,
        status: input.status,
        name: input.name,
        url: input.url,
        fileName: input.fileName,
        mimeType: input.mimeType,
        rawText: input.rawText,
        metadata: input.metadata
          ? this.toJsonObject(input.metadata)
          : undefined,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: source.organizationId,
      action: 'knowledge_source.updated',
      entityType: 'knowledge_source',
      entityId: source.id,
      metadata: this.removeUndefined({
        type: input.type,
        status: input.status,
        name: input.name,
        url: input.url,
      }),
    });

    return this.toSafeSource(source);
  }

  async deleteSource(currentUser: AuthenticatedUser, id: string) {
    const source = await this.findSourceForActor(currentUser, id);
    await this.prisma.knowledgeSource.delete({ where: { id } });

    await this.auditService.record({
      actor: currentUser,
      organizationId: source.organizationId,
      action: 'knowledge_source.deleted',
      entityType: 'knowledge_source',
      entityId: id,
      metadata: {
        type: source.type,
        name: source.name,
      },
    });

    return { deleted: true };
  }

  async listDocuments(
    currentUser: AuthenticatedUser,
    sourceId?: string,
  ): Promise<SafeKnowledgeDocument[]> {
    if (sourceId) {
      await this.findSourceForActor(currentUser, sourceId);
    }

    const documents = await this.prisma.knowledgeDocument.findMany({
      where: {
        ...(this.isSuperAdmin(currentUser)
          ? {}
          : { organizationId: currentUser.orgId }),
        ...(sourceId ? { sourceId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return documents.map((document) => this.toSafeDocument(document));
  }

  async listChunks(
    currentUser: AuthenticatedUser,
    filters: {
      sourceId?: string;
      documentId?: string;
      q?: string;
    },
  ): Promise<SafeKnowledgeChunk[]> {
    if (filters.sourceId) {
      await this.findSourceForActor(currentUser, filters.sourceId);
    }

    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: {
        ...(this.isSuperAdmin(currentUser)
          ? {}
          : { organizationId: currentUser.orgId }),
        ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
        ...(filters.documentId ? { documentId: filters.documentId } : {}),
        ...(filters.q
          ? { content: { contains: filters.q, mode: 'insensitive' } }
          : {}),
      },
      orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
    });

    return chunks.map((chunk) => this.toSafeChunk(chunk));
  }

  async search(
    currentUser: AuthenticatedUser,
    input: SearchKnowledgeDto,
  ): Promise<KnowledgeSearchRow[]> {
    if (input.sourceId) {
      await this.findSourceForActor(currentUser, input.sourceId);
    }

    const embedding = await this.embeddingsService.embedText({
      organizationId: currentUser.orgId,
      text: input.query,
    });
    const limit = input.limit ?? 5;
    const sourceFilter = input.sourceId
      ? Prisma.sql`AND "source_id" = ${input.sourceId}`
      : Prisma.empty;

    return this.prisma.$queryRaw<KnowledgeSearchRow[]>`
      SELECT
        "id",
        "organization_id" AS "organizationId",
        "source_id" AS "sourceId",
        "document_id" AS "documentId",
        "chunk_index" AS "chunkIndex",
        "content",
        (1 - ("embedding" <=> ${toPgVector(embedding.vector)}::vector))::float AS "score",
        "embedding_model" AS "embeddingModel",
        "embedding_provider"::text AS "embeddingProvider"
      FROM "knowledge_chunks"
      WHERE "organization_id" = ${currentUser.orgId}
        AND "embedding" IS NOT NULL
        ${sourceFilter}
      ORDER BY "embedding" <=> ${toPgVector(embedding.vector)}::vector
      LIMIT ${limit}
    `;
  }

  private async findSourceForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<KnowledgeSource> {
    const source = await this.prisma.knowledgeSource.findUnique({
      where: { id },
    });

    if (!source) {
      throw new NotFoundException('Knowledge source not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      source.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Knowledge source not found');
    }

    return source;
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ): string {
    if (!organizationId) {
      return currentUser.orgId;
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      organizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException('Cannot manage another organization');
    }

    return organizationId;
  }

  private resolveInitialStatus(): 'pending' {
    return 'pending';
  }

  private toSafeSource(source: KnowledgeSource): SafeKnowledgeSource {
    return {
      ...source,
      fileSizeBytes: source.fileSizeBytes ? Number(source.fileSizeBytes) : null,
      metadata: this.toRecord(source.metadata),
    };
  }

  private toSafeDocument(document: KnowledgeDocument): SafeKnowledgeDocument {
    return {
      ...document,
      metadata: this.toRecord(document.metadata),
    };
  }

  private toSafeChunk(chunk: KnowledgeChunk): SafeKnowledgeChunk {
    return {
      ...chunk,
      metadata: this.toRecord(chunk.metadata),
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private async enqueueIngestion(
    source: KnowledgeSource,
    reason: 'source_created' | 'file_uploaded',
  ): Promise<KnowledgeSource> {
    if (
      !this.ingestionQueueService.isEnabled() &&
      (source.rawText ||
        source.type === 'website_url' ||
        source.type === 'uploaded_file')
    ) {
      await this.ingestionService.ingestSource({
        organizationId: source.organizationId,
        sourceId: source.id,
        reason,
      });
      return this.prisma.knowledgeSource.findUniqueOrThrow({
        where: { id: source.id },
      });
    }

    try {
      await this.ingestionQueueService.enqueue({
        organizationId: source.organizationId,
        sourceId: source.id,
        reason,
      });

      return source;
    } catch (error) {
      return this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'failed',
          errorMessage: `Knowledge ingestion could not be queued: ${this.toErrorMessage(error)}`,
        },
      });
    }
  }

  private parseMetadata(value?: string): Record<string, unknown> {
    if (!value) {
      return {};
    }

    try {
      const parsed = JSON.parse(value) as unknown;

      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Metadata must be a JSON object');
      }

      return parsed as Record<string, unknown>;
    } catch {
      throw new BadRequestException('metadata must be a valid JSON object');
    }
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
