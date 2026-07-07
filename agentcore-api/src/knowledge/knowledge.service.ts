import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KnowledgeDocument, KnowledgeSource, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { CreateKnowledgeSourceDto } from './dto/create-knowledge-source.dto';
import { UpdateKnowledgeSourceDto } from './dto/update-knowledge-source.dto';

type SafeKnowledgeSource = Omit<KnowledgeSource, 'metadata'> & {
  metadata: Record<string, unknown>;
};

type SafeKnowledgeDocument = Omit<KnowledgeDocument, 'metadata'> & {
  metadata: Record<string, unknown>;
};

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

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

    const source = await this.prisma.$transaction(async (tx) => {
      const createdSource = await tx.knowledgeSource.create({
        data: {
          organizationId,
          type: input.type,
          status: input.status ?? this.resolveInitialStatus(input),
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

    return this.toSafeSource(source);
  }

  async getSourceById(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeKnowledgeSource> {
    const source = await this.findSourceForActor(currentUser, id);
    return this.toSafeSource(source);
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

    return this.toSafeSource(source);
  }

  async deleteSource(currentUser: AuthenticatedUser, id: string) {
    await this.findSourceForActor(currentUser, id);
    await this.prisma.knowledgeSource.delete({ where: { id } });

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

  private resolveInitialStatus(
    input: CreateKnowledgeSourceDto,
  ): 'pending' | 'ready' {
    return input.rawText ? 'ready' : 'pending';
  }

  private toSafeSource(source: KnowledgeSource): SafeKnowledgeSource {
    return {
      ...source,
      metadata: this.toRecord(source.metadata),
    };
  }

  private toSafeDocument(document: KnowledgeDocument): SafeKnowledgeDocument {
    return {
      ...document,
      metadata: this.toRecord(document.metadata),
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

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
