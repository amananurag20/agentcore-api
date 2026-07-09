import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export interface ScrapedPage {
  title: string;
  url: string;
  text: string;
  statusCode: number;
  links: string[];
}

@Injectable()
export class UrlScraperService {
  private readonly maxBytes: number;
  private readonly maxPages: number;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.maxBytes =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_MAX_BYTES') ??
      1_000_000;
    this.maxPages =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_MAX_PAGES') ?? 5;
    this.timeoutMs =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_TIMEOUT_MS') ??
      10_000;
  }

  async scrape(startUrl: string): Promise<ScrapedPage[]> {
    const rootUrl = this.normalizeHttpUrl(startUrl);
    await this.assertPublicUrl(rootUrl);

    const seen = new Set<string>();
    const queue = [rootUrl];
    const pages: ScrapedPage[] = [];

    while (queue.length && pages.length < this.maxPages) {
      const url = queue.shift()!;

      if (seen.has(url)) {
        continue;
      }

      seen.add(url);

      const page = await this.fetchPage(url);
      if (page.text) {
        pages.push(page);
      }

      if (pages.length >= this.maxPages) {
        break;
      }

      for (const link of page.links) {
        if (!seen.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }
    }

    if (!pages.length) {
      throw new BadRequestException('No readable website content was found');
    }

    return pages;
  }

  private async fetchPage(url: string): Promise<ScrapedPage> {
    const response = await this.fetchWithSafeRedirects(url);

    if (!response.ok) {
      throw new BadRequestException(`Website returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      throw new BadRequestException(
        `Unsupported website content type: ${contentType || 'unknown'}`,
      );
    }

    const html = await this.readLimitedText(response);
    const finalUrl = this.normalizeHttpUrl(response.url || url);
    const title = this.extractTitle(html) || finalUrl;
    const text = this.htmlToText(html);
    const links = this.extractSameOriginLinks(finalUrl, html);

    return {
      title,
      url: finalUrl,
      text,
      statusCode: response.status,
      links,
    };
  }

  private async fetchWithSafeRedirects(url: string): Promise<Response> {
    let currentUrl = this.normalizeHttpUrl(url);

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await this.assertPublicUrl(currentUrl);

      const response = await fetch(currentUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': 'AgentCoreKnowledgeBot/1.0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }

      const location = response.headers.get('location');

      if (!location) {
        return response;
      }

      currentUrl = this.normalizeHttpUrl(
        new URL(location, currentUrl).toString(),
      );
    }

    throw new BadRequestException('Website redirected too many times');
  }

  private async readLimitedText(response: Response): Promise<string> {
    const reader = response.body?.getReader();

    if (!reader) {
      return response.text();
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > this.maxBytes) {
        throw new BadRequestException(
          `Website page is larger than ${this.maxBytes} bytes`,
        );
      }

      chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  private extractSameOriginLinks(pageUrl: string, html: string): string[] {
    const page = new URL(pageUrl);
    const links = new Set<string>();
    const hrefRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = this.decodeHtml(match[1]);

      try {
        const link = new URL(href, page);
        link.hash = '';

        if (
          link.protocol === page.protocol &&
          link.hostname === page.hostname &&
          !this.isSkippedLink(link)
        ) {
          links.add(link.toString());
        }
      } catch {
        continue;
      }
    }

    return [...links].slice(0, this.maxPages * 3);
  }

  private htmlToText(html: string): string {
    return this.decodeHtml(
      html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(
          /<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi,
          ' ',
        )
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(
          /<\/(p|div|section|article|main|header|footer|li|h[1-6]|br)>/gi,
          '\n',
        )
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    );
  }

  private extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match?.[1] ? this.decodeHtml(match[1]).trim() : null;
  }

  private normalizeHttpUrl(input: string): string {
    let url: URL;

    try {
      url = new URL(input);
    } catch {
      throw new BadRequestException('Invalid website URL');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('Website URL must use http or https');
    }

    url.hash = '';
    return url.toString();
  }

  private async assertPublicUrl(input: string): Promise<void> {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();

    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new BadRequestException('Private or local URLs are not allowed');
    }

    if (this.isPrivateIp(hostname)) {
      throw new BadRequestException('Private or local URLs are not allowed');
    }

    try {
      const addresses = await lookup(hostname, { all: true });

      if (addresses.some((entry) => this.isPrivateIp(entry.address))) {
        throw new BadRequestException('Private or local URLs are not allowed');
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('Website host could not be resolved');
    }
  }

  private isPrivateIp(value: string): boolean {
    const ipVersion = isIP(value);

    if (ipVersion === 4) {
      const parts = value.split('.').map(Number);
      const [a, b] = parts;

      return (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a === 0
      );
    }

    if (ipVersion === 6) {
      const normalized = value.toLowerCase();
      return (
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80:')
      );
    }

    return false;
  }

  private isSkippedLink(url: URL): boolean {
    return (
      ['mailto:', 'tel:', 'javascript:'].includes(url.protocol) ||
      /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|avi|mov)$/i.test(
        url.pathname,
      )
    );
  }

  private decodeHtml(input: string): string {
    const namedEntities: Record<string, string> = {
      amp: '&',
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"',
      apos: "'",
    };

    return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
      const normalizedCode = String(code).toLowerCase();

      if (normalizedCode.startsWith('#x')) {
        return String.fromCodePoint(
          Number.parseInt(normalizedCode.slice(2), 16),
        );
      }

      if (normalizedCode.startsWith('#')) {
        return String.fromCodePoint(
          Number.parseInt(normalizedCode.slice(1), 10),
        );
      }

      return namedEntities[normalizedCode] ?? entity;
    });
  }
}
