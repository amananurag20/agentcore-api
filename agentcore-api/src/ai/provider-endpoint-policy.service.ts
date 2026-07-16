import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AIProviderConfig } from '@prisma/client';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TRUSTED_PROVIDER_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'api.mistral.ai',
]);

@Injectable()
export class ProviderEndpointPolicyService {
  private readonly allowPrivateNetworks: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly production: boolean;

  constructor(configService: ConfigService) {
    this.allowPrivateNetworks =
      configService.get<boolean>('AI_PROVIDER_ALLOW_PRIVATE_NETWORKS') ?? false;
    this.allowedHosts = new Set(
      (configService.get<string>('AI_PROVIDER_ALLOWED_HOSTS') ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );
    this.production = configService.get<string>('NODE_ENV') === 'production';
  }

  async assertProviderAllowed(
    config: Pick<AIProviderConfig, 'provider' | 'baseUrl'> & {
      settings: unknown;
    },
  ): Promise<void> {
    const endpoint = this.resolveEndpoint(config);
    await this.assertUrlAllowed(endpoint);
  }

  async assertUrlAllowed(value: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Provider Base URL is invalid');
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new BadRequestException('Provider Base URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new BadRequestException(
        'Provider Base URL must not contain credentials',
      );
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const explicitlyAllowed =
      this.allowedHosts.has(hostname) ||
      this.allowedHosts.has(`${hostname}:${url.port || this.defaultPort(url)}`);
    if (
      this.production &&
      url.protocol !== 'https:' &&
      !this.allowPrivateNetworks
    ) {
      throw new BadRequestException(
        'Custom AI provider endpoints must use HTTPS in production',
      );
    }
    if (TRUSTED_PROVIDER_HOSTS.has(hostname) || explicitlyAllowed) return;

    if (this.production) {
      throw new BadRequestException(
        'Custom AI provider hostname is not allowlisted. Add it to AI_PROVIDER_ALLOWED_HOSTS before using it in production.',
      );
    }
    if (this.isBlockedHostname(hostname)) {
      this.assertPrivateAccessAllowed(hostname);
      return;
    }

    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new BadRequestException('Provider hostname could not be resolved');
    }
    if (addresses.length === 0) {
      throw new BadRequestException('Provider hostname has no IP address');
    }
    if (addresses.some(({ address }) => this.isPrivateAddress(address))) {
      this.assertPrivateAccessAllowed(hostname);
    }
  }

  private resolveEndpoint(
    config: Pick<AIProviderConfig, 'provider' | 'baseUrl'> & {
      settings: unknown;
    },
  ): string {
    if (config.baseUrl) return config.baseUrl;
    const settings = this.toRecord(config.settings);
    const adapter = settings.adapter;
    if (config.provider === 'anthropic' || adapter === 'anthropic') {
      return 'https://api.anthropic.com/v1';
    }
    if (config.provider === 'local' || adapter === 'ollama') {
      return 'http://localhost:11434';
    }
    if (adapter === 'mistral') return 'https://api.mistral.ai/v1';
    return 'https://api.openai.com/v1';
  }

  private assertPrivateAccessAllowed(hostname: string): void {
    if (!this.allowPrivateNetworks) {
      throw new BadRequestException(
        `Provider endpoint ${hostname} resolves to a private or local network. Add it to AI_PROVIDER_ALLOWED_HOSTS only for an intentional private deployment.`,
      );
    }
  }

  private isBlockedHostname(hostname: string): boolean {
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      this.isPrivateAddress(hostname)
    );
  }

  private isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase();
    if (isIP(normalized) === 4) {
      const parts = normalized.split('.').map(Number);
      return (
        parts[0] === 0 ||
        parts[0] === 10 ||
        parts[0] === 127 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
        parts[0] >= 224
      );
    }
    if (isIP(normalized) === 6) {
      return (
        normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('::ffff:127.') ||
        normalized.startsWith('::ffff:10.') ||
        normalized.startsWith('::ffff:192.168.')
      );
    }
    return false;
  }

  private defaultPort(url: URL): string {
    return url.protocol === 'https:' ? '443' : '80';
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    return value as Record<string, unknown>;
  }
}
