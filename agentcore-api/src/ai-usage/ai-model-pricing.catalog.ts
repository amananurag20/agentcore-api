import type { AIUsageCapability } from './ai-usage.service';

export interface AIModelCatalogPrice {
  provider: string;
  model: string;
  capability: AIUsageCapability;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  effectiveFrom: string;
  catalogVersion: string;
  sourceUrl: string;
}

const OPENAI_CATALOG_VERSION = 'openai-2026-07-16';

export const AI_MODEL_PRICE_CATALOG: AIModelCatalogPrice[] = [
  openAIChat('gpt-4.1', 2, 8),
  openAIChat('gpt-4.1-mini', 0.4, 1.6),
  openAIChat('gpt-4.1-nano', 0.1, 0.4),
  openAIChat('gpt-4o', 2.5, 10),
  openAIChat('gpt-4o-mini', 0.15, 0.6),
  openAIEmbedding('text-embedding-3-small', 0.02),
  openAIEmbedding('text-embedding-3-large', 0.13),
];

export function findCatalogPrice(
  provider: string,
  model: string,
  capability: AIUsageCapability,
): AIModelCatalogPrice | undefined {
  const normalizedModel = normalizeModel(model);
  return AI_MODEL_PRICE_CATALOG.find(
    (entry) =>
      entry.provider === provider &&
      entry.capability === capability &&
      entry.model === normalizedModel,
  );
}

function normalizeModel(model: string): string {
  const exact = AI_MODEL_PRICE_CATALOG.find((entry) => entry.model === model);
  if (exact) return exact.model;
  return (
    AI_MODEL_PRICE_CATALOG.find((entry) => model.startsWith(`${entry.model}-`))
      ?.model ?? model
  );
}

function openAIChat(
  model: string,
  inputPerMillionUsd: number,
  outputPerMillionUsd: number,
): AIModelCatalogPrice {
  return {
    provider: 'openai',
    model,
    capability: 'chat',
    inputPerMillionUsd,
    outputPerMillionUsd,
    effectiveFrom: '2026-07-16',
    catalogVersion: OPENAI_CATALOG_VERSION,
    sourceUrl: `https://developers.openai.com/api/docs/models/${model}`,
  };
}

function openAIEmbedding(
  model: string,
  inputPerMillionUsd: number,
): AIModelCatalogPrice {
  return {
    provider: 'openai',
    model,
    capability: 'embedding',
    inputPerMillionUsd,
    outputPerMillionUsd: 0,
    effectiveFrom: '2026-07-16',
    catalogVersion: OPENAI_CATALOG_VERSION,
    sourceUrl: `https://developers.openai.com/api/docs/models/${model}`,
  };
}
