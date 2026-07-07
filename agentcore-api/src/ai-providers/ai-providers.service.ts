import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AIProviderConfig, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAIProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAIProviderDto } from './dto/update-ai-provider.dto';

type SafeAIProviderConfig = Omit<
  AIProviderConfig,
  'apiKeyEncrypted' | 'settings'
> & {
  hasApiKey: boolean;
  settings: Record<string, unknown>;
};

@Injectable()
export class AIProvidersService {
  constructor(
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  async list(currentUser: AuthenticatedUser): Promise<SafeAIProviderConfig[]> {
    const configs = await this.prisma.aIProviderConfig.findMany({
      where: this.isSuperAdmin(currentUser)
        ? undefined
        : { organizationId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
    });

    return configs.map((config) => this.toSafeConfig(config));
  }

  async create(
    currentUser: AuthenticatedUser,
    input: CreateAIProviderDto,
  ): Promise<SafeAIProviderConfig> {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );

    const config = await this.prisma.aIProviderConfig.create({
      data: {
        organizationId,
        provider: input.provider,
        status: input.status ?? 'active',
        name: input.name,
        baseUrl: input.baseUrl,
        apiKeyEncrypted: input.apiKey
          ? this.cryptoService.encrypt(input.apiKey)
          : undefined,
        chatModel: input.chatModel,
        embeddingModel: input.embeddingModel,
        rerankModel: input.rerankModel,
        sttModel: input.sttModel,
        ttsModel: input.ttsModel,
        settings: this.toJsonObject(input.settings),
      },
    });

    return this.toSafeConfig(config);
  }

  async getById(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<SafeAIProviderConfig> {
    const config = await this.findConfigForActor(currentUser, id);
    return this.toSafeConfig(config);
  }

  async update(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAIProviderDto,
  ): Promise<SafeAIProviderConfig> {
    await this.findConfigForActor(currentUser, id);

    const config = await this.prisma.aIProviderConfig.update({
      where: { id },
      data: {
        organizationId: input.organizationId
          ? this.resolveOrganizationId(currentUser, input.organizationId)
          : undefined,
        provider: input.provider,
        status: input.status,
        name: input.name,
        baseUrl: input.baseUrl,
        apiKeyEncrypted:
          input.apiKey === undefined
            ? undefined
            : this.cryptoService.encrypt(input.apiKey),
        chatModel: input.chatModel,
        embeddingModel: input.embeddingModel,
        rerankModel: input.rerankModel,
        sttModel: input.sttModel,
        ttsModel: input.ttsModel,
        settings: input.settings
          ? this.toJsonObject(input.settings)
          : undefined,
      },
    });

    return this.toSafeConfig(config);
  }

  async delete(currentUser: AuthenticatedUser, id: string) {
    await this.findConfigForActor(currentUser, id);
    await this.prisma.aIProviderConfig.delete({ where: { id } });

    return { deleted: true };
  }

  private async findConfigForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ): Promise<AIProviderConfig> {
    const config = await this.prisma.aIProviderConfig.findUnique({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('AI provider config not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      config.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('AI provider config not found');
    }

    return config;
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

  private toSafeConfig(config: AIProviderConfig): SafeAIProviderConfig {
    const { apiKeyEncrypted, ...safeConfig } = config;

    return {
      ...safeConfig,
      settings: this.toRecord(safeConfig.settings),
      hasApiKey: Boolean(apiKeyEncrypted),
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
