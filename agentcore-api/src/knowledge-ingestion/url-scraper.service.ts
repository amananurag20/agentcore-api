import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export interface ScrapedPage {
  title: string;
  url: string;
  text: string;
  statusCode: number;
  links: string[];
}

type RobotsRules = {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
};

const BOT_USER_AGENT = 'AgentCoreKnowledgeBot/1.0';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];
const TRACKING_PARAMS = [
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
];

@Injectable()
export class UrlScraperService {
  private readonly maxBytes: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly respectRobots: boolean;
  private readonly sitemapEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.maxBytes =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_MAX_BYTES') ??
      1_000_000;
    this.maxPages =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_MAX_PAGES') ?? 5;
    this.maxRetries =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_MAX_RETRIES') ?? 2;
    this.respectRobots =
      this.configService.get<boolean>('KNOWLEDGE_URL_SCRAPER_RESPECT_ROBOTS') ??
      true;
    this.sitemapEnabled =
      this.configService.get<boolean>(
        'KNOWLEDGE_URL_SCRAPER_SITEMAP_ENABLED',
      ) ?? true;
    this.timeoutMs =
      this.configService.get<number>('KNOWLEDGE_URL_SCRAPER_TIMEOUT_MS') ??
      10_000;
  }

  async scrape(startUrl: string): Promise<ScrapedPage[]> {
    const rootUrl = this.normalizeHttpUrl(startUrl);
    await this.assertPublicUrl(rootUrl);

    const robots = await this.loadRobotsRules(rootUrl);
    this.assertRobotsAllowed(rootUrl, robots);

    const seen = new Set<string>();
    const queued = new Set<string>([rootUrl]);
    const queue = [
      rootUrl,
      ...(await this.discoverSitemapUrls(rootUrl, robots)).filter(
        (url) => url !== rootUrl,
      ),
    ].slice(0, this.maxPages * 3);
    const pages: ScrapedPage[] = [];

    for (const item of queue) {
      queued.add(item);
    }

    while (queue.length && pages.length < this.maxPages) {
      const url = queue.shift()!;

      if (seen.has(url)) {
        continue;
      }

      seen.add(url);
      this.assertRobotsAllowed(url, robots);

      const page = await this.fetchPage(url);
      if (this.isUsefulText(page.text)) {
        pages.push(page);
      }

      if (pages.length >= this.maxPages) {
        break;
      }

      for (const link of page.links) {
        if (!seen.has(link) && !queued.has(link)) {
          queued.add(link);
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

    const body = await this.readLimitedText(response);
    const finalUrl = this.normalizeHttpUrl(response.url || url);

    if (contentType.includes('text/plain')) {
      const text = this.cleanText(body);
      return {
        title: finalUrl,
        url: finalUrl,
        text,
        statusCode: response.status,
        links: [],
      };
    }

    const $ = cheerio.load(body);
    const title = this.extractTitle($) || finalUrl;
    const text = this.extractReadableText($);
    const links = this.extractSameOriginLinks(finalUrl, $);

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

      const response = await this.safeFetch(currentUrl);

      if (!REDIRECT_STATUSES.includes(response.status)) {
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

  private async safeFetch(url: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept:
              'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            'User-Agent': BOT_USER_AGENT,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (
          attempt < this.maxRetries &&
          RETRYABLE_STATUSES.includes(response.status)
        ) {
          await this.sleep(250 * (attempt + 1));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;

        if (attempt < this.maxRetries) {
          await this.sleep(250 * (attempt + 1));
          continue;
        }
      }
    }

    throw new BadRequestException(
      `Website could not be fetched: ${this.toErrorMessage(lastError)}`,
    );
  }

  private async loadRobotsRules(startUrl: string): Promise<RobotsRules | null> {
    if (!this.respectRobots && !this.sitemapEnabled) {
      return null;
    }

    const origin = new URL(startUrl).origin;
    const robotsUrl = `${origin}/robots.txt`;

    try {
      await this.assertPublicUrl(robotsUrl);
      const response = await fetch(robotsUrl, {
        headers: {
          Accept: 'text/plain,*/*;q=0.8',
          'User-Agent': BOT_USER_AGENT,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return null;
      }

      return this.parseRobotsTxt(await this.readLimitedText(response));
    } catch {
      return null;
    }
  }

  private parseRobotsTxt(content: string): RobotsRules {
    const groups: Array<{
      agents: string[];
      allow: string[];
      disallow: string[];
    }> = [];
    const sitemaps: string[] = [];
    let current:
      { agents: string[]; allow: string[]; disallow: string[] } | undefined;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, '').trim();
      if (!line) {
        continue;
      }

      const separator = line.indexOf(':');
      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (key === 'sitemap' && value) {
        sitemaps.push(value);
        continue;
      }

      if (key === 'user-agent') {
        current = { agents: [value.toLowerCase()], allow: [], disallow: [] };
        groups.push(current);
        continue;
      }

      if (!current) {
        continue;
      }

      if (key === 'allow') {
        current.allow.push(value);
      }

      if (key === 'disallow') {
        current.disallow.push(value);
      }
    }

    const matchingGroups = groups.filter((group) =>
      group.agents.some(
        (agent) =>
          agent === '*' ||
          BOT_USER_AGENT.toLowerCase().startsWith(agent.toLowerCase()),
      ),
    );
    const selected = matchingGroups[0];

    return {
      allow: selected?.allow ?? [],
      disallow: selected?.disallow ?? [],
      sitemaps,
    };
  }

  private async discoverSitemapUrls(
    rootUrl: string,
    robots: RobotsRules | null,
  ): Promise<string[]> {
    if (!this.sitemapEnabled) {
      return [];
    }

    const origin = new URL(rootUrl).origin;
    const sitemapUrls = robots?.sitemaps.length
      ? robots.sitemaps
      : [`${origin}/sitemap.xml`];
    const discovered = new Set<string>();

    for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
      try {
        const normalizedSitemapUrl = this.normalizeHttpUrl(sitemapUrl);
        await this.assertPublicUrl(normalizedSitemapUrl);
        const response = await this.safeFetch(normalizedSitemapUrl);

        if (!response.ok) {
          continue;
        }

        const xml = await this.readLimitedText(response);
        for (const url of this.extractSitemapLocs(xml, rootUrl)) {
          discovered.add(url);
          if (discovered.size >= this.maxPages * 3) {
            return [...discovered];
          }
        }
      } catch {
        continue;
      }
    }

    return [...discovered];
  }

  private extractSitemapLocs(xml: string, rootUrl: string): string[] {
    const root = new URL(rootUrl);
    const locs = new Set<string>();
    const locRegex = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
    let match: RegExpExecArray | null;

    while ((match = locRegex.exec(xml)) !== null) {
      try {
        const url = this.normalizeHttpUrl(this.decodeHtml(match[1].trim()));
        const parsed = new URL(url);

        if (
          parsed.protocol === root.protocol &&
          parsed.hostname === root.hostname &&
          !this.isSkippedLink(parsed)
        ) {
          locs.add(url);
        }
      } catch {
        continue;
      }
    }

    return [...locs];
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

  private extractSameOriginLinks(pageUrl: string, $: CheerioAPI): string[] {
    const page = new URL(pageUrl);
    const links = new Set<string>();

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) {
        return;
      }

      try {
        const link = new URL(href, page);
        const normalized = this.normalizeHttpUrl(link.toString());
        const parsed = new URL(normalized);

        if (
          parsed.protocol === page.protocol &&
          parsed.hostname === page.hostname &&
          !this.isSkippedLink(parsed)
        ) {
          links.add(normalized);
        }
      } catch {
        return;
      }
    });

    return [...links].slice(0, this.maxPages * 3);
  }

  private extractReadableText($: CheerioAPI): string {
    $(
      'script, style, noscript, svg, canvas, iframe, form, input, button',
    ).remove();
    $('[aria-hidden="true"], [hidden]').remove();
    $('nav, footer, header, aside').remove();
    $('.nav, .navbar, .footer, .sidebar, .menu, .breadcrumb').remove();
    $('#nav, #navbar, #footer, #sidebar, #menu, #breadcrumb').remove();

    const candidateSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.content',
      '#content',
      '.course-content',
      '.lesson-content',
      'body',
    ];
    const bestSelector =
      candidateSelectors
        .map((selector) => ({
          selector,
          text: this.cleanText($(selector).first().text()),
        }))
        .filter((candidate) => candidate.text.length > 0)
        .sort((a, b) => b.text.length - a.text.length)[0]?.selector ?? 'body';
    const root = $(bestSelector).first();
    const blocks: string[] = [];

    root
      .find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,dt,dd')
      .each((_, element) => {
        const text = this.cleanText($(element).text());
        if (text) {
          blocks.push(text);
        }
      });

    if (!blocks.length) {
      blocks.push(this.cleanText(root.text()));
    }

    return this.dedupeLines(blocks.join('\n\n'));
  }

  private extractTitle($: CheerioAPI): string | null {
    const candidates = [
      $('meta[property="og:title"]').attr('content'),
      $('meta[name="twitter:title"]').attr('content'),
      $('h1').first().text(),
      $('title').first().text(),
    ];

    for (const candidate of candidates) {
      const title = this.cleanText(candidate ?? '');
      if (title) {
        return title;
      }
    }

    return null;
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
    url.hostname = url.hostname.toLowerCase();

    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }

    url.searchParams.sort();

    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

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

  private assertRobotsAllowed(url: string, robots: RobotsRules | null) {
    if (!this.respectRobots || !robots) {
      return;
    }

    const path = new URL(url).pathname || '/';
    const matchingAllow = this.longestMatchingRule(path, robots.allow);
    const matchingDisallow = this.longestMatchingRule(path, robots.disallow);

    if (
      matchingDisallow &&
      (!matchingAllow || matchingDisallow.length > matchingAllow.length)
    ) {
      throw new BadRequestException('Website robots.txt disallows scraping');
    }
  }

  private longestMatchingRule(path: string, rules: string[]): string | null {
    return (
      rules
        .filter((rule) => rule && this.matchesRobotsRule(path, rule))
        .sort((a, b) => b.length - a.length)[0] ?? null
    );
  }

  private matchesRobotsRule(path: string, rule: string): boolean {
    if (rule === '/') {
      return true;
    }

    const escaped = rule
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$/g, '$');

    return new RegExp(`^${escaped}`).test(path);
  }

  private isUsefulText(text: string): boolean {
    const normalized = this.cleanText(text);
    return normalized.length >= 80 && /[a-zA-Z]{3,}/.test(normalized);
  }

  private cleanText(input: string): string {
    return this.decodeHtml(input)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private dedupeLines(input: string): string {
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const line of input.split(/\n+/)) {
      const cleaned = this.cleanText(line);
      const key = cleaned.toLowerCase();

      if (!cleaned || seen.has(key)) {
        continue;
      }

      seen.add(key);
      lines.push(cleaned);
    }

    return lines.join('\n\n');
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
