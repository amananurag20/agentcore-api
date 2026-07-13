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
import { extname } from 'path';
import { EmbeddingsService } from '../ai/embeddings.service';
import { toPgVector } from '../ai/vector-sql';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import type { ProductKey } from '../common/auth/product-access.types';
import { KnowledgeIngestionQueueService } from '../knowledge-ingestion/knowledge-ingestion-queue.service';
import { KnowledgeIngestionService } from '../knowledge-ingestion/knowledge-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyService } from '../policy/policy.service';
import { S3StorageService } from '../storage/s3-storage.service';
import { FileSecurityService } from '../storage/file-security.service';
import { CreateKnowledgeSourceDto } from './dto/create-knowledge-source.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { UpdateKnowledgeSourceDto } from './dto/update-knowledge-source.dto';
import { UploadKnowledgeFileDto } from './dto/upload-knowledge-file.dto';
import {
  CreateKnowledgeCategoryDto,
  CreateKnowledgeFolderDto,
  UpdateKnowledgeCategoryDto,
  UpdateKnowledgeFolderDto,
} from './dto/knowledge-taxonomy.dto';
import { ListKnowledgeSourcesDto } from './dto/list-knowledge-sources.dto';

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
    private readonly policyService: PolicyService,
    private readonly prisma: PrismaService,
    private readonly fileSecurityService: FileSecurityService,
    private readonly storageService: S3StorageService,
  ) {}

  async listSources(
    currentUser: AuthenticatedUser,
    query: ListKnowledgeSourcesDto,
  ) {
    const requestedOrgId = query.organizationId
      ? this.resolveOrganizationId(currentUser, query.organizationId)
      : undefined;
    const scope = requestedOrgId
      ? { organizationId: requestedOrgId }
      : this.scopedKnowledgeWhere(currentUser);
    const where: Prisma.KnowledgeSourceWhereInput = {
      ...scope,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.quarantined !== undefined
        ? { isQuarantined: query.quarantined }
        : {}),
      ...(query.folderId
        ? { folderId: query.folderId === 'unfiled' ? null : query.folderId }
        : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { fileName: { contains: query.search, mode: 'insensitive' } },
              { url: { contains: query.search, mode: 'insensitive' } },
              { categories: { has: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const [sources, total] = await Promise.all([
      this.prisma.knowledgeSource.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.knowledgeSource.count({ where }),
    ]);
    return {
      data: sources.map((source) => this.toSafeSource(source)),
      pageInfo: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async createSource(
    currentUser: AuthenticatedUser,
    input: CreateKnowledgeSourceDto,
  ): Promise<SafeKnowledgeSource> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCanManageProducts(currentUser, input.productVisibility);
    await this.assertFolderBelongsToOrganization(
      input.folderId,
      organizationId,
    );

    let source = await this.prisma.$transaction(async (tx) => {
      const createdSource = await tx.knowledgeSource.create({
        data: {
          organizationId,
          type: input.type,
          status: input.status ?? this.resolveInitialStatus(),
          name: input.name,
          sensitivityLevel: input.sensitivityLevel,
          levelSource: input.sensitivityLevel === undefined ? 'auto' : 'manual',
          productVisibility: input.productVisibility,
          categories: input.categories,
          isQuarantined: input.isQuarantined,
          folderId: input.folderId,
          url: input.url,
          fileName: input.fileName,
          mimeType: input.mimeType,
          rawText: input.rawText,
          metadata: this.toJsonObject(input.metadata),
          recrawlIntervalHours:
            input.type === 'website_url' ? input.recrawlIntervalHours : null,
          nextCrawlAt:
            input.type === 'website_url' && input.recrawlIntervalHours
              ? new Date(Date.now() + input.recrawlIntervalHours * 60 * 60_000)
              : null,
        },
      });

      if (input.rawText) {
        await tx.knowledgeDocument.create({
          data: {
            organizationId,
            sourceId: createdSource.id,
            title: input.name,
            sensitivityLevel: input.sensitivityLevel,
            productVisibility: input.productVisibility,
            categories: input.categories,
            isQuarantined: input.isQuarantined,
            uri: input.url,
            contentText: input.rawText,
            metadata: this.toJsonObject(input.metadata),
          },
        });
      }
      await this.registerCategories(
        tx,
        organizationId,
        input.categories ?? [],
        false,
      );

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
        sensitivityLevel: source.sensitivityLevel,
        productVisibility: source.productVisibility,
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
    this.assertSupportedUploadFile(file);
    const malwareScan = await this.fileSecurityService.scan(file.buffer);

    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertCanManageProducts(currentUser, input.productVisibility);
    await this.assertFolderBelongsToOrganization(
      input.folderId,
      organizationId,
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
        sensitivityLevel: input.sensitivityLevel,
        levelSource: input.sensitivityLevel === undefined ? 'auto' : 'manual',
        productVisibility: input.productVisibility,
        categories: input.categories,
        folderId: input.folderId,
        fileName: file.originalname,
        mimeType: file.mimetype,
        storageProvider: storedObject.provider,
        storageBucket: storedObject.bucket,
        storageKey: storedObject.key,
        fileSizeBytes: storedObject.sizeBytes,
        checksumSha256: storedObject.checksumSha256,
        malwareScanStatus: malwareScan.status,
        malwareScanMessage: malwareScan.message,
        metadata: this.toJsonObject({
          ...metadata,
          malwareScan: {
            status: malwareScan.status,
            message: malwareScan.message,
            scannedAt: new Date().toISOString(),
          },
        }),
      },
    });

    source = await this.enqueueIngestion(source, 'file_uploaded');
    await this.registerCategories(
      this.prisma,
      organizationId,
      input.categories ?? [],
      false,
    );

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
        sensitivityLevel: source.sensitivityLevel,
        productVisibility: source.productVisibility,
      },
    });

    return this.toSafeSource(source);
  }

  async getSourceById(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeKnowledgeSource> {
    const source = await this.findSourceForActor(currentUser, id);
    await this.assertCanManageProducts(currentUser, source.productVisibility);
    return this.toSafeSource(source);
  }

  async ingestSource(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeKnowledgeSource> {
    const source = await this.findSourceForActor(currentUser, id);
    await this.assertCanManageProducts(currentUser, source.productVisibility);

    if (this.ingestionQueueService.isEnabled()) {
      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: 'pending', errorMessage: null },
      });
      await this.ingestionQueueService.enqueue({
        organizationId: source.organizationId,
        sourceId: source.id,
        reason: 'manual_retry',
      });
    } else {
      await this.ingestionService.ingestSource({
        organizationId: source.organizationId,
        sourceId: source.id,
        reason: 'manual_retry',
      });
    }

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
    const existing = await this.findSourceForActor(currentUser, id);
    await this.assertCanManageProducts(
      currentUser,
      input.productVisibility ?? existing.productVisibility,
    );
    await this.assertFolderBelongsToOrganization(
      input.folderId,
      input.organizationId ?? existing.organizationId,
    );
    const releasesQuarantine =
      existing.isQuarantined && input.isQuarantined === false;
    const metadata = {
      ...this.toRecord(existing.metadata),
      ...(input.metadata ?? {}),
      ...(releasesQuarantine
        ? {
            classificationApprovedAt: new Date().toISOString(),
            classificationApprovedBy: currentUser.sub,
          }
        : {}),
    };

    const source = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.knowledgeSource.update({
        where: { id },
        data: {
          organizationId: input.organizationId
            ? this.resolveOrganizationId(currentUser, input.organizationId)
            : undefined,
          type: input.type,
          status: input.status,
          name: input.name,
          sensitivityLevel: input.sensitivityLevel,
          levelSource:
            input.sensitivityLevel === undefined ? undefined : 'manual',
          productVisibility: input.productVisibility,
          categories: input.categories,
          isQuarantined: input.isQuarantined,
          folderId: input.folderId,
          url: input.url,
          fileName: input.fileName,
          mimeType: input.mimeType,
          rawText: input.rawText,
          recrawlIntervalHours: input.recrawlIntervalHours,
          nextCrawlAt:
            input.recrawlIntervalHours === undefined
              ? undefined
              : input.recrawlIntervalHours
                ? new Date(
                    Date.now() + input.recrawlIntervalHours * 60 * 60_000,
                  )
                : null,
          metadata:
            input.metadata || releasesQuarantine
              ? this.toJsonObject(metadata)
              : undefined,
        },
      });

      const inheritedAccess = this.removeUndefined({
        sensitivityLevel: input.sensitivityLevel,
        productVisibility: input.productVisibility,
        categories: input.categories,
        isQuarantined: input.isQuarantined,
      });
      if (Object.keys(inheritedAccess).length) {
        await tx.knowledgeDocument.updateMany({
          where: { sourceId: id },
          data: inheritedAccess,
        });
        await tx.knowledgeChunk.updateMany({
          where: { sourceId: id },
          data: inheritedAccess,
        });
      }
      if (input.categories) {
        await this.registerCategories(
          tx,
          updated.organizationId,
          input.categories,
          false,
        );
      }

      return updated;
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
        sensitivityLevel: input.sensitivityLevel,
        productVisibility: input.productVisibility,
        isQuarantined: input.isQuarantined,
        recrawlIntervalHours: input.recrawlIntervalHours,
      }),
    });
    if (releasesQuarantine) {
      await this.auditService.record({
        actor: currentUser,
        organizationId: source.organizationId,
        action: 'knowledge_source.quarantine_released',
        entityType: 'knowledge_source',
        entityId: source.id,
        metadata: { sensitivityLevel: source.sensitivityLevel },
      });
    }

    return this.toSafeSource(source);
  }

  async deleteSource(currentUser: AuthenticatedUser, id: string) {
    const source = await this.findSourceForActor(currentUser, id);
    await this.assertCanManageProducts(currentUser, source.productVisibility);
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

  async listCategories(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ) {
    const orgId = this.resolveOrganizationId(currentUser, organizationId);
    return this.prisma.knowledgeCategory.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(
    currentUser: AuthenticatedUser,
    input: CreateKnowledgeCategoryDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    this.assertCanManageAnyKnowledge(currentUser);
    const [category] = await this.registerCategories(
      this.prisma,
      organizationId,
      [input.name],
      false,
    );
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'knowledge_category.created',
      entityType: 'knowledge_category',
      entityId: category.id,
      metadata: { name: category.name },
    });
    return category;
  }

  async deleteCategory(currentUser: AuthenticatedUser, id: string) {
    const category = await this.prisma.knowledgeCategory.findUnique({
      where: { id },
    });
    if (
      !category ||
      (!this.isSuperAdmin(currentUser) &&
        category.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Knowledge category not found');
    }
    this.assertCanManageAnyKnowledge(currentUser);
    await this.prisma.$transaction(async (tx) => {
      const [sources, documents, chunks] = await Promise.all([
        tx.knowledgeSource.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
        tx.knowledgeDocument.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
        tx.knowledgeChunk.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
      ]);
      await Promise.all([
        ...sources.map((entry) =>
          tx.knowledgeSource.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.filter(
                (value) => value !== category.name,
              ),
            },
          }),
        ),
        ...documents.map((entry) =>
          tx.knowledgeDocument.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.filter(
                (value) => value !== category.name,
              ),
            },
          }),
        ),
        ...chunks.map((entry) =>
          tx.knowledgeChunk.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.filter(
                (value) => value !== category.name,
              ),
            },
          }),
        ),
      ]);
      await tx.knowledgeCategory.delete({ where: { id } });
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: category.organizationId,
      action: 'knowledge_category.deleted',
      entityType: 'knowledge_category',
      entityId: id,
      metadata: { name: category.name },
    });
    return { deleted: true };
  }

  async updateCategory(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateKnowledgeCategoryDto,
  ) {
    const category = await this.findCategoryForActor(currentUser, id);
    this.assertCanManageAnyKnowledge(currentUser);
    const name = input.name.trim();
    const slug = this.slugify(name);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.knowledgeCategory.update({
        where: { id },
        data: { name, slug },
      });
      const [sources, documents, chunks] = await Promise.all([
        tx.knowledgeSource.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
        tx.knowledgeDocument.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
        tx.knowledgeChunk.findMany({
          where: {
            organizationId: category.organizationId,
            categories: { has: category.name },
          },
          select: { id: true, categories: true },
        }),
      ]);
      await Promise.all([
        ...sources.map((entry) =>
          tx.knowledgeSource.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.map((value) =>
                value === category.name ? name : value,
              ),
            },
          }),
        ),
        ...documents.map((entry) =>
          tx.knowledgeDocument.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.map((value) =>
                value === category.name ? name : value,
              ),
            },
          }),
        ),
        ...chunks.map((entry) =>
          tx.knowledgeChunk.update({
            where: { id: entry.id },
            data: {
              categories: entry.categories.map((value) =>
                value === category.name ? name : value,
              ),
            },
          }),
        ),
      ]);
      return result;
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: category.organizationId,
      action: 'knowledge_category.updated',
      entityType: 'knowledge_category',
      entityId: id,
      metadata: { previousName: category.name, name },
    });
    return updated;
  }

  async listFolders(currentUser: AuthenticatedUser, organizationId?: string) {
    const orgId = this.resolveOrganizationId(currentUser, organizationId);
    return this.prisma.knowledgeFolder.findMany({
      where: { organizationId: orgId },
      include: { _count: { select: { sources: true, children: true } } },
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
    });
  }

  async createFolder(
    currentUser: AuthenticatedUser,
    input: CreateKnowledgeFolderDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    this.assertCanManageAnyKnowledge(currentUser);
    await this.assertFolderBelongsToOrganization(
      input.parentId,
      organizationId,
    );
    const folder = await this.prisma.knowledgeFolder.create({
      data: {
        organizationId,
        name: input.name.trim(),
        parentId: input.parentId,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'knowledge_folder.created',
      entityType: 'knowledge_folder',
      entityId: folder.id,
      metadata: { name: folder.name, parentId: folder.parentId },
    });
    return folder;
  }

  async deleteFolder(currentUser: AuthenticatedUser, id: string) {
    const folder = await this.prisma.knowledgeFolder.findUnique({
      where: { id },
    });
    if (
      !folder ||
      (!this.isSuperAdmin(currentUser) &&
        folder.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Knowledge folder not found');
    }
    this.assertCanManageAnyKnowledge(currentUser);
    await this.prisma.knowledgeFolder.delete({ where: { id } });
    await this.auditService.record({
      actor: currentUser,
      organizationId: folder.organizationId,
      action: 'knowledge_folder.deleted',
      entityType: 'knowledge_folder',
      entityId: id,
      metadata: { name: folder.name },
    });
    return { deleted: true };
  }

  async updateFolder(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateKnowledgeFolderDto,
  ) {
    const folder = await this.findFolderForActor(currentUser, id);
    this.assertCanManageAnyKnowledge(currentUser);
    if (input.parentId === id)
      throw new BadRequestException('Folder cannot be its own parent');
    await this.assertFolderBelongsToOrganization(
      input.parentId ?? undefined,
      folder.organizationId,
    );
    await this.assertFolderMoveDoesNotCycle(id, input.parentId);
    const updated = await this.prisma.knowledgeFolder.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: folder.organizationId,
      action: 'knowledge_folder.updated',
      entityType: 'knowledge_folder',
      entityId: id,
      metadata: { name: updated.name, parentId: updated.parentId },
    });
    return updated;
  }

  async listSourceVersions(currentUser: AuthenticatedUser, id: string) {
    await this.findSourceForActor(currentUser, id);
    const versions = await this.prisma.knowledgeSourceVersion.findMany({
      where: { sourceId: id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        contentFingerprint: true,
        documentCount: true,
        chunkCount: true,
        metadata: true,
        createdAt: true,
      },
    });
    return versions.map((version) => ({
      ...version,
      metadata: this.toRecord(version.metadata),
    }));
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
        ...this.scopedKnowledgeWhere(currentUser),
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
        ...this.scopedKnowledgeWhere(currentUser),
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
    const productFilter = input.productKey
      ? Prisma.sql`AND ${input.productKey}::"ProductKey" = ANY("product_visibility")`
      : Prisma.empty;
    const clearanceLevel = input.productKey
      ? this.policyService.getEffectiveClearance(currentUser, input.productKey)
      : (currentUser.clearanceLevel ?? 0);

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
        AND "sensitivity_level" <= ${clearanceLevel}
        AND "is_quarantined" = false
        AND "embedding" IS NOT NULL
        ${sourceFilter}
        ${productFilter}
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
    if (!this.canViewKnowledgeItem(currentUser, source)) {
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

  private assertSupportedUploadFile(file: Express.Multer.File) {
    if (!file.size) {
      throw new BadRequestException('Uploaded file is empty');
    }

    const extension = extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype.toLowerCase();
    const allowedExtensions = new Set([
      '.pdf',
      '.docx',
      '.xlsx',
      '.txt',
      '.md',
      '.csv',
      '.tsv',
    ]);
    const allowedMimeTypes = new Set([
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/tab-separated-values',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);

    if (allowedMimeTypes.has(mimeType) || allowedExtensions.has(extension)) {
      return;
    }

    throw new BadRequestException(
      'Unsupported file type. Upload PDF, DOCX, XLSX, TXT, Markdown, CSV, or TSV files.',
    );
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private async assertCanManageProducts(
    user: AuthenticatedUser,
    productVisibility?: Array<
      | 'customer_chat'
      | 'appointment_booking'
      | 'whatsapp_assistant'
      | 'voice_receptionist'
    >,
  ) {
    if (this.isSuperAdmin(user) || user.roles.includes('org_admin')) return;
    if (!productVisibility?.length) {
      throw new BadRequestException(
        'Product visibility is required for delegated knowledge managers',
      );
    }
    for (const productKey of productVisibility ?? []) {
      await this.policyService.assertProductAccess(
        user,
        productKey,
        'manage_knowledge',
      );
    }
  }

  private scopedKnowledgeWhere(user: AuthenticatedUser) {
    if (this.isSuperAdmin(user)) return {};
    if (user.roles.includes('org_admin')) {
      return { organizationId: user.orgId };
    }

    const scopes = this.getManagedProductScopes(user);
    return {
      organizationId: user.orgId,
      OR: scopes.map(({ productKey, clearanceLevel }) => ({
        productVisibility: { has: productKey },
        sensitivityLevel: { lte: clearanceLevel },
      })),
    };
  }

  private canViewKnowledgeItem(
    user: AuthenticatedUser,
    item: { productVisibility: ProductKey[]; sensitivityLevel: number },
  ) {
    if (this.isSuperAdmin(user) || user.roles.includes('org_admin'))
      return true;
    return this.getManagedProductScopes(user).some(
      ({ productKey, clearanceLevel }) =>
        item.productVisibility.includes(productKey) &&
        item.sensitivityLevel <= clearanceLevel,
    );
  }

  private getManagedProductScopes(user: AuthenticatedUser) {
    const keys = new Set<ProductKey>();
    for (const access of user.productAccess ?? []) {
      if (access.canManageKnowledge || access.canConfigure) {
        keys.add(access.productKey);
      }
    }
    for (const role of user.customRoles ?? []) {
      for (const access of role.productAccess) {
        if (access.canManageKnowledge || access.canConfigure) {
          keys.add(access.productKey);
        }
      }
    }
    return [...keys].map((productKey) => ({
      productKey,
      clearanceLevel: this.policyService.getEffectiveClearance(
        user,
        productKey,
      ),
    }));
  }

  private assertCanManageAnyKnowledge(user: AuthenticatedUser) {
    if (this.isSuperAdmin(user) || user.roles.includes('org_admin')) return;
    if (!this.getManagedProductScopes(user).length) {
      throw new ForbiddenException('Knowledge management access is required');
    }
  }

  private async assertFolderBelongsToOrganization(
    folderId: string | null | undefined,
    organizationId: string,
  ) {
    if (!folderId) return;
    const folder = await this.prisma.knowledgeFolder.findFirst({
      where: { id: folderId, organizationId },
      select: { id: true },
    });
    if (!folder) throw new BadRequestException('Knowledge folder is invalid');
  }

  private async findCategoryForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ) {
    const category = await this.prisma.knowledgeCategory.findUnique({
      where: { id },
    });
    if (
      !category ||
      (!this.isSuperAdmin(currentUser) &&
        category.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Knowledge category not found');
    }
    return category;
  }

  private async assertFolderMoveDoesNotCycle(
    folderId: string,
    parentId: string | null | undefined,
  ) {
    let cursor = parentId;
    for (let depth = 0; cursor && depth < 100; depth += 1) {
      if (cursor === folderId) {
        throw new BadRequestException('Folder move would create a cycle');
      }
      const parent = await this.prisma.knowledgeFolder.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId;
    }
    if (cursor) throw new BadRequestException('Folder hierarchy is too deep');
  }

  private async findFolderForActor(currentUser: AuthenticatedUser, id: string) {
    const folder = await this.prisma.knowledgeFolder.findUnique({
      where: { id },
    });
    if (
      !folder ||
      (!this.isSuperAdmin(currentUser) &&
        folder.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Knowledge folder not found');
    }
    return folder;
  }

  private slugify(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  private async registerCategories(
    client: Pick<PrismaService, 'knowledgeCategory'> | Prisma.TransactionClient,
    organizationId: string,
    names: string[],
    isSystem: boolean,
  ) {
    const normalized = [
      ...new Set(names.map((name) => name.trim()).filter(Boolean)),
    ];
    if (!normalized.length) return [];
    await client.knowledgeCategory.createMany({
      data: normalized.map((name) => ({
        organizationId,
        name,
        slug: this.slugify(name),
        isSystem,
      })),
      skipDuplicates: true,
    });
    return client.knowledgeCategory.findMany({
      where: {
        organizationId,
        slug: {
          in: normalized.map((name) => this.slugify(name)),
        },
      },
      orderBy: { name: 'asc' },
    });
  }
}
