import { validate } from 'class-validator';
import { IsBoundedJson } from './is-bounded-json.decorator';

class MetadataFixture {
  @IsBoundedJson({
    maxBytes: 100,
    maxDepth: 2,
    maxEntries: 3,
    maxStringLength: 20,
  })
  metadata?: Record<string, unknown>;
}

describe('IsBoundedJson', () => {
  it('accepts small structured metadata', async () => {
    const fixture = new MetadataFixture();
    fixture.metadata = { page: '/pricing', campaign: 'summer' };
    await expect(validate(fixture)).resolves.toHaveLength(0);
  });

  it('rejects oversized and excessively nested metadata', async () => {
    const oversized = new MetadataFixture();
    oversized.metadata = { value: 'x'.repeat(21) };
    expect(await validate(oversized)).not.toHaveLength(0);

    const nested = new MetadataFixture();
    nested.metadata = { one: { two: { three: true } } };
    expect(await validate(nested)).not.toHaveLength(0);
  });
});
