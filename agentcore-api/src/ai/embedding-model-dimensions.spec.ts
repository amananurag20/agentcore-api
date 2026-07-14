import { resolveEmbeddingDimensions } from './embedding-model-dimensions';

describe('resolveEmbeddingDimensions', () => {
  it('returns known provider model dimensions', () => {
    expect(resolveEmbeddingDimensions('text-embedding-3-small', {})).toBe(1536);
    expect(resolveEmbeddingDimensions('text-embedding-3-large', {})).toBe(3072);
  });

  it('requires a positive integer dimension for unknown models', () => {
    expect(resolveEmbeddingDimensions('custom-embed', {})).toBeNull();
    expect(
      resolveEmbeddingDimensions('custom-embed', {
        embeddingDimensions: 1536,
      }),
    ).toBe(1536);
    expect(
      resolveEmbeddingDimensions('custom-embed', {
        embeddingDimensions: 1.5,
      }),
    ).toBeNull();
  });
});
