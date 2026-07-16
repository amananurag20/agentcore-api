import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

@Injectable()
export class CryptoService {
  private readonly activeKeyId: string;
  private readonly keys: Map<string, Buffer>;

  constructor(configService: ConfigService) {
    const legacySecret = configService.getOrThrow<string>(
      'AI_CONFIG_ENCRYPTION_KEY',
    );
    const configuredKeys = this.parseKeyring(
      configService.get<string>('AI_CONFIG_ENCRYPTION_KEYS'),
    );
    if (configuredKeys.length === 0)
      configuredKeys.push(['legacy', legacySecret]);

    this.activeKeyId = configuredKeys[0][0];
    this.keys = new Map(
      configuredKeys.map(([id, secret]) => [id, this.deriveKey(secret)]),
    );
    if (!this.keys.has('legacy')) {
      this.keys.set('legacy', this.deriveKey(legacySecret));
    }
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.keys.get(this.activeKeyId)!,
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      this.activeKeyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length === 5 && parts[0] === 'v1') {
      const key = this.keys.get(parts[1]);
      if (!key) throw new Error(`Unknown encryption key id: ${parts[1]}`);
      return this.decryptWithKey(parts.slice(2), key);
    }
    if (parts.length !== 3) throw new Error('Invalid encrypted value');

    for (const key of this.keys.values()) {
      try {
        return this.decryptWithKey(parts, key);
      } catch {
        // Legacy values have no key id, so try every retained rotation key.
      }
    }
    throw new Error(
      'Encrypted value could not be decrypted with configured keys',
    );
  }

  private decryptWithKey(parts: string[], key: Buffer): string {
    const [iv, tag, encrypted] = parts.map((part) =>
      Buffer.from(part, 'base64url'),
    );
    const decipher = createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  private parseKeyring(value?: string): Array<[string, string]> {
    if (!value?.trim()) return [];
    const seen = new Set<string>();
    return value.split(',').map((entry) => {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator).trim();
      const secret = entry.slice(separator + 1).trim();
      if (separator < 1 || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
        throw new Error('AI_CONFIG_ENCRYPTION_KEYS contains an invalid key id');
      }
      if (secret.length < 32) {
        throw new Error(
          `Encryption key ${id} must contain at least 32 characters`,
        );
      }
      if (seen.has(id)) throw new Error(`Duplicate encryption key id: ${id}`);
      seen.add(id);
      return [id, secret] as [string, string];
    });
  }

  private deriveKey(secret: string): Buffer {
    return createHash('sha256').update(secret).digest();
  }
}
