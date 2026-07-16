import {
  AIProviderBudgetExceededError,
  AIUsageService,
} from './ai-usage.service';

describe('AIUsageService', () => {
  it('stores token usage and computes configured micro-dollar cost', async () => {
    type CreateUsage = {
      inputTokens: bigint;
      outputTokens: bigint;
      totalTokens: bigint;
      estimatedCostMicros: bigint;
      successCount: number;
    };
    type UsageDailyMock = {
      captured: { create: CreateUsage } | undefined;
      upsert(
        this: UsageDailyMock,
        input: { create: CreateUsage },
      ): Promise<Record<string, never>>;
    };
    const usageDaily: UsageDailyMock = {
      captured: undefined,
      upsert(this: UsageDailyMock, input: { create: CreateUsage }) {
        this.captured = input;
        return Promise.resolve({});
      },
    };
    const upsert = jest.spyOn(usageDaily, 'upsert');
    const service = new AIUsageService({
      aIProviderUsageDaily: usageDaily,
    } as never);

    await service.record({
      provider: {
        id: 'provider-a',
        organizationId: 'org-a',
        settings: {
          pricing: {
            chatInputPerMillionUsd: 0.5,
            chatOutputPerMillionUsd: 1.5,
          },
        },
      } as never,
      capability: 'chat',
      model: 'chat-model',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      latencyMs: 250,
      success: true,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(usageDaily.captured?.create.inputTokens).toBe(100n);
    expect(usageDaily.captured?.create.outputTokens).toBe(20n);
    expect(usageDaily.captured?.create.totalTokens).toBe(120n);
    expect(usageDaily.captured?.create.estimatedCostMicros).toBe(80n);
    expect(usageDaily.captured?.create.successCount).toBe(1);
  });

  it('uses exact OpenAI catalog pricing when no workspace override exists', async () => {
    let captured: { create: { estimatedCostMicros: bigint } } | undefined;
    const upsert = jest.fn(
      (input: { create: { estimatedCostMicros: bigint } }) => {
        captured = input;
        return Promise.resolve({});
      },
    );
    const service = new AIUsageService({
      aIProviderUsageDaily: { upsert },
    } as never);

    await service.record({
      provider: {
        id: 'provider-openai',
        organizationId: 'org-a',
        provider: 'openai',
        settings: {},
      } as never,
      capability: 'chat',
      model: 'gpt-4.1-mini',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
      latencyMs: 100,
      success: true,
    });

    expect(captured?.create.estimatedCostMicros).toBe(2_000_000n);
  });

  it('ignores stored workspace rates when pricing overrides are disabled', async () => {
    let captured: { create: { estimatedCostMicros: bigint } } | undefined;
    const service = new AIUsageService({
      aIProviderUsageDaily: {
        upsert: (input: { create: { estimatedCostMicros: bigint } }) => {
          captured = input;
          return Promise.resolve({});
        },
      },
    } as never);

    await service.record({
      provider: {
        id: 'provider-openai',
        organizationId: 'org-a',
        provider: 'openai',
        settings: {
          pricingOverrideEnabled: false,
          modelPricing: {
            'gpt-4.1-mini': {
              inputPerMillionUsd: 99,
              outputPerMillionUsd: 99,
            },
          },
        },
      } as never,
      capability: 'chat',
      model: 'gpt-4.1-mini',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
      latencyMs: 100,
      success: true,
    });

    expect(captured?.create.estimatedCostMicros).toBe(2_000_000n);
  });

  it('blocks calls after a hard monthly budget is exhausted', async () => {
    const aggregate = jest.fn().mockResolvedValue({
      _sum: { estimatedCostMicros: 1_000_000n },
    });
    const service = new AIUsageService({
      aIProviderUsageDaily: { aggregate },
    } as never);

    await expect(
      service.assertBudgetAvailable({
        id: 'provider-a',
        settings: { monthlyBudgetUsd: 1, budgetMode: 'block' },
      } as never),
    ).rejects.toBeInstanceOf(AIProviderBudgetExceededError);
  });

  it('does not query spend when budget mode only tracks usage', async () => {
    const aggregate = jest.fn();
    const service = new AIUsageService({
      aIProviderUsageDaily: { aggregate },
    } as never);

    await service.assertBudgetAvailable({
      id: 'provider-a',
      settings: { monthlyBudgetUsd: 1, budgetMode: 'tracking' },
    } as never);

    expect(aggregate).not.toHaveBeenCalled();
  });
});
