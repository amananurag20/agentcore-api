const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-ada-002': 1536,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'mistral-embed': 1024,
  'nomic-embed-text': 768,
  'all-minilm': 384,
};

export function resolveEmbeddingDimensions(
  model: string,
  settings: Record<string, unknown>,
): number | null {
  const knownDimensions = KNOWN_EMBEDDING_DIMENSIONS[model.toLowerCase()];
  if (knownDimensions) return knownDimensions;

  const configuredDimensions = settings.embeddingDimensions;
  return typeof configuredDimensions === 'number' &&
    Number.isInteger(configuredDimensions) &&
    configuredDimensions > 0
    ? configuredDimensions
    : null;
}
