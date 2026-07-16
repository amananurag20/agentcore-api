import { createCipheriv, createHash, randomBytes } from 'crypto';
import { CryptoService } from './crypto.service';

const OLD_SECRET = 'old-secret-that-is-at-least-thirty-two-characters';
const NEW_SECRET = 'new-secret-that-is-at-least-thirty-two-characters';

function config(values: Record<string, string>) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (!values[key]) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as never;
}

describe('CryptoService key rotation', () => {
  it('labels new ciphertext with the active key id', () => {
    const service = new CryptoService(
      config({
        AI_CONFIG_ENCRYPTION_KEY: OLD_SECRET,
        AI_CONFIG_ENCRYPTION_KEYS: `current:${NEW_SECRET},previous:${OLD_SECRET}`,
      }),
    );

    const encrypted = service.encrypt('provider-key');

    expect(encrypted.startsWith('v1.current.')).toBe(true);
    expect(service.decrypt(encrypted)).toBe('provider-key');
  });

  it('decrypts versioned ciphertext written with a retained previous key', () => {
    const previous = new CryptoService(
      config({
        AI_CONFIG_ENCRYPTION_KEY: OLD_SECRET,
        AI_CONFIG_ENCRYPTION_KEYS: `previous:${OLD_SECRET}`,
      }),
    );
    const encrypted = previous.encrypt('provider-key');
    const rotated = new CryptoService(
      config({
        AI_CONFIG_ENCRYPTION_KEY: OLD_SECRET,
        AI_CONFIG_ENCRYPTION_KEYS: `current:${NEW_SECRET},previous:${OLD_SECRET}`,
      }),
    );

    expect(rotated.decrypt(encrypted)).toBe('provider-key');
  });

  it('continues to decrypt legacy ciphertext without a key id', () => {
    const key = createHash('sha256').update(OLD_SECRET).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update('legacy-key', 'utf8'),
      cipher.final(),
    ]);
    const legacyValue = [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString('base64url'))
      .join('.');
    const service = new CryptoService(
      config({
        AI_CONFIG_ENCRYPTION_KEY: OLD_SECRET,
        AI_CONFIG_ENCRYPTION_KEYS: `current:${NEW_SECRET},previous:${OLD_SECRET}`,
      }),
    );

    expect(service.decrypt(legacyValue)).toBe('legacy-key');
  });
});
