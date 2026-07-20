import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

@Injectable()
export class OcrEndpointPolicyService {
  private readonly allowedHosts: Set<string>;
  private readonly allowPrivateNetworks: boolean;

  constructor(configService: ConfigService) {
    this.allowedHosts = new Set(
      (configService.get<string>('KNOWLEDGE_OCR_ALLOWED_HOSTS') ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );
    this.allowPrivateNetworks =
      configService.get<boolean>('KNOWLEDGE_OCR_ALLOW_PRIVATE_NETWORKS') ??
      false;
  }

  async assertAllowed(endpoint: string, hasApiKey: boolean): Promise<void> {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new BadRequestException('OCR endpoint is not a valid URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException('OCR endpoint must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new BadRequestException(
        'OCR endpoint must not contain credentials',
      );
    }
    if (hasApiKey && url.protocol !== 'https:') {
      throw new BadRequestException(
        'OCR API keys may only be sent to HTTPS endpoints',
      );
    }
    if (!this.allowedHosts.size) {
      throw new BadRequestException(
        'OCR endpoint hosts must be configured in KNOWLEDGE_OCR_ALLOWED_HOSTS',
      );
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const hostWithPort = `${hostname}:${url.port || this.defaultPort(url)}`;
    if (
      !this.allowedHosts.has(hostname) &&
      !this.allowedHosts.has(hostWithPort)
    ) {
      throw new BadRequestException(
        'OCR endpoint host is not allowed by the deployment policy',
      );
    }

    if (this.isPrivateAddress(hostname) || this.isLocalHostname(hostname)) {
      this.assertPrivateNetworksAllowed();
      return;
    }

    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new BadRequestException('OCR endpoint hostname could not resolve');
    }
    if (
      !addresses.length ||
      addresses.some(({ address }) => this.isPrivateAddress(address))
    ) {
      this.assertPrivateNetworksAllowed();
    }
  }

  private assertPrivateNetworksAllowed(): void {
    if (!this.allowPrivateNetworks) {
      throw new BadRequestException(
        'OCR endpoint resolves to a private or local network',
      );
    }
  }

  private isLocalHostname(hostname: string): boolean {
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
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
        /^fe[89ab]/.test(normalized) ||
        normalized.startsWith('::ffff:127.') ||
        normalized.startsWith('::ffff:10.') ||
        normalized.startsWith('::ffff:169.254.') ||
        normalized.startsWith('::ffff:192.168.')
      );
    }
    return false;
  }

  private defaultPort(url: URL): string {
    return url.protocol === 'https:' ? '443' : '80';
  }
}
