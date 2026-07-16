import { Injectable, Logger } from '@nestjs/common';
import { AIProviderConfig, AIProviderUsageDaily } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AIUsage } from '../ai/adapters/ai-adapter.types';
import { findCatalogPrice } from './ai-model-pricing.catalog';

export type AIUsageCapability = 'chat' | 'embedding' | 'transcription';
export type AIProviderBudgetMode = 'tracking' | 'warn' | 'block';

export class AIProviderBudgetExceededError extends Error {
  constructor(providerId: string) {
    super(`Monthly AI budget reached for provider ${providerId}`);
    this.name = 'AIProviderBudgetExceededError';
  }
}

@Injectable()
export class AIUsageService {
  private readonly logger = new Logger(AIUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    provider: AIProviderConfig;
    capability: AIUsageCapability;
    model: string;
    usage?: AIUsage;
    latencyMs: number;
    success: boolean;
  }): Promise<void> {
    const usageDate = this.startOfUtcDay(new Date());
    const tokens = input.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const estimatedCostMicros = this.estimateCostMicros(
      input.provider,
      input.capability,
      input.model,
      tokens,
    );

    try {
      await this.prisma.aIProviderUsageDaily.upsert({
        where: {
          providerConfigId_usageDate_capability_model: {
            providerConfigId: input.provider.id,
            usageDate,
            capability: input.capability,
            model: input.model,
          },
        },
        create: {
          organizationId: input.provider.organizationId,
          providerConfigId: input.provider.id,
          usageDate,
          capability: input.capability,
          model: input.model,
          requestCount: 1,
          successCount: input.success ? 1 : 0,
          failureCount: input.success ? 0 : 1,
          inputTokens: BigInt(tokens.inputTokens),
          outputTokens: BigInt(tokens.outputTokens),
          totalTokens: BigInt(tokens.totalTokens),
          estimatedCostMicros,
          totalLatencyMs: BigInt(Math.max(0, Math.round(input.latencyMs))),
        },
        update: {
          requestCount: { increment: 1 },
          successCount: { increment: input.success ? 1 : 0 },
          failureCount: { increment: input.success ? 0 : 1 },
          inputTokens: { increment: BigInt(tokens.inputTokens) },
          outputTokens: { increment: BigInt(tokens.outputTokens) },
          totalTokens: { increment: BigInt(tokens.totalTokens) },
          estimatedCostMicros: { increment: estimatedCostMicros },
          totalLatencyMs: {
            increment: BigInt(Math.max(0, Math.round(input.latencyMs))),
          },
        },
      });
    } catch (error) {
      this.logger.warn(
        `Unable to persist AI usage for provider ${input.provider.id}: ${this.message(error)}`,
      );
    }
  }

  async summarize(provider: AIProviderConfig) {
    const summaries = await this.summarizeMany([provider]);
    return summaries.get(provider.id)!;
  }

  async assertBudgetAvailable(provider: AIProviderConfig): Promise<void> {
    const settings = this.recordValue(provider.settings);
    const mode = this.budgetMode(settings.budgetMode);
    const budgetUsd = this.numberValue(settings.monthlyBudgetUsd);
    if (mode !== 'block' || budgetUsd === null || budgetUsd <= 0) return;

    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const aggregate = await this.prisma.aIProviderUsageDaily.aggregate({
      where: {
        providerConfigId: provider.id,
        usageDate: { gte: monthStart },
      },
      _sum: { estimatedCostMicros: true },
    });
    const spentMicros = Number(aggregate._sum.estimatedCostMicros ?? 0n);
    if (spentMicros >= Math.round(budgetUsd * 1_000_000)) {
      throw new AIProviderBudgetExceededError(provider.id);
    }
  }

  async summarizeMany(providers: AIProviderConfig[]) {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const rows = await this.prisma.aIProviderUsageDaily.findMany({
      where: {
        providerConfigId: { in: providers.map((provider) => provider.id) },
        usageDate: { gte: monthStart },
      },
      orderBy: [{ usageDate: 'asc' }, { capability: 'asc' }],
    });

    return new Map(
      providers.map((provider) => [
        provider.id,
        this.buildSummary(
          provider,
          rows.filter((row) => row.providerConfigId === provider.id),
          monthStart,
          now,
        ),
      ]),
    );
  }

  private buildSummary(
    provider: AIProviderConfig,
    rows: AIProviderUsageDaily[],
    monthStart: Date,
    now: Date,
  ) {
    const totals = rows.reduce(
      (sum, row) => ({
        requests: sum.requests + row.requestCount,
        successes: sum.successes + row.successCount,
        failures: sum.failures + row.failureCount,
        inputTokens: sum.inputTokens + Number(row.inputTokens),
        outputTokens: sum.outputTokens + Number(row.outputTokens),
        totalTokens: sum.totalTokens + Number(row.totalTokens),
        costMicros: sum.costMicros + Number(row.estimatedCostMicros),
        latencyMs: sum.latencyMs + Number(row.totalLatencyMs),
      }),
      {
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costMicros: 0,
        latencyMs: 0,
      },
    );
    const settings = this.recordValue(provider.settings);
    const budget = this.numberValue(settings.monthlyBudgetUsd);
    const budgetMode = this.budgetMode(settings.budgetMode);
    const estimatedCostUsd = totals.costMicros / 1_000_000;

    return {
      periodStart: monthStart.toISOString(),
      periodEnd: now.toISOString(),
      requests: totals.requests,
      successes: totals.successes,
      failures: totals.failures,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      averageLatencyMs:
        totals.requests > 0
          ? Math.round(totals.latencyMs / totals.requests)
          : 0,
      estimatedCostUsd,
      monthlyBudgetUsd: budget,
      budgetMode,
      budgetExceeded: budget !== null && estimatedCostUsd >= budget,
      remainingBudgetUsd:
        budget === null ? null : Math.max(0, budget - estimatedCostUsd),
      budgetUsedPercent:
        budget && budget > 0
          ? Math.min(100, (estimatedCostUsd / budget) * 100)
          : null,
      pricingConfigured: this.hasPricing(provider),
      modelPricing: [
        ...(provider.chatModel
          ? [this.pricingFor(provider, provider.chatModel, 'chat')]
          : []),
        ...(provider.embeddingModel
          ? [this.pricingFor(provider, provider.embeddingModel, 'embedding')]
          : []),
      ],
      vendorBalance: {
        status: 'not_available',
        remainingUsd: null,
        reason:
          'This provider does not expose account credit through the configured inference API key.',
      },
      breakdown: rows.map((row) => ({
        date: row.usageDate.toISOString().slice(0, 10),
        capability: row.capability,
        model: row.model,
        requests: row.requestCount,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        totalTokens: Number(row.totalTokens),
        estimatedCostUsd: Number(row.estimatedCostMicros) / 1_000_000,
      })),
    };
  }

  private estimateCostMicros(
    provider: AIProviderConfig,
    capability: AIUsageCapability,
    model: string,
    usage: AIUsage,
  ): bigint {
    const pricing = this.pricingFor(provider, model, capability);
    const inputRate = pricing.inputPerMillionUsd ?? 0;
    const outputRate = pricing.outputPerMillionUsd ?? 0;
    return BigInt(
      Math.max(
        0,
        Math.round(
          usage.inputTokens * inputRate + usage.outputTokens * outputRate,
        ),
      ),
    );
  }

  private hasPricing(provider: AIProviderConfig): boolean {
    return [
      ...(provider.chatModel
        ? [this.pricingFor(provider, provider.chatModel, 'chat')]
        : []),
      ...(provider.embeddingModel
        ? [this.pricingFor(provider, provider.embeddingModel, 'embedding')]
        : []),
    ].some(
      (pricing) =>
        pricing.inputPerMillionUsd !== null ||
        (pricing.capability === 'chat' && pricing.outputPerMillionUsd !== null),
    );
  }

  private pricingFor(
    provider: AIProviderConfig,
    model: string,
    capability: AIUsageCapability,
  ) {
    const settings = this.recordValue(provider.settings);
    const modelPricing = this.recordValue(settings.modelPricing);
    const override = this.recordValue(modelPricing[model]);
    const generic = this.recordValue(settings.pricing);
    const useLegacyGenericPricing = Object.keys(modelPricing).length === 0;
    const pricingOverrideEnabled =
      settings.pricingOverrideEnabled === true ||
      settings.pricingOverrideEnabled === undefined;
    const catalog = findCatalogPrice(provider.provider, model, capability);
    const overrideInput = pricingOverrideEnabled
      ? this.numberValue(override.inputPerMillionUsd)
      : null;
    const overrideOutput = pricingOverrideEnabled
      ? this.numberValue(override.outputPerMillionUsd)
      : null;
    const genericInput =
      pricingOverrideEnabled &&
      useLegacyGenericPricing &&
      capability === 'embedding'
        ? this.numberValue(generic.embeddingInputPerMillionUsd)
        : pricingOverrideEnabled && useLegacyGenericPricing
          ? this.numberValue(generic.chatInputPerMillionUsd)
          : null;
    const genericOutput =
      pricingOverrideEnabled && useLegacyGenericPricing && capability === 'chat'
        ? this.numberValue(generic.chatOutputPerMillionUsd)
        : null;
    const inputPerMillionUsd =
      overrideInput ?? genericInput ?? catalog?.inputPerMillionUsd ?? null;
    const outputPerMillionUsd =
      capability === 'chat'
        ? (overrideOutput ??
          genericOutput ??
          catalog?.outputPerMillionUsd ??
          null)
        : 0;
    return {
      model,
      capability,
      inputPerMillionUsd,
      outputPerMillionUsd,
      source:
        overrideInput !== null || overrideOutput !== null
          ? 'workspace_override'
          : genericInput !== null || genericOutput !== null
            ? 'workspace_default'
            : catalog
              ? 'provider_catalog'
              : 'not_configured',
      catalogUpdatedAt: catalog?.effectiveFrom ?? null,
      catalogVersion: catalog?.catalogVersion ?? null,
      catalogSourceUrl: catalog?.sourceUrl ?? null,
    };
  }

  private startOfUtcDay(value: Date): Date {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  private budgetMode(value: unknown): AIProviderBudgetMode {
    return value === 'warn' || value === 'block' ? value : 'tracking';
  }

  private recordValue(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private numberValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
