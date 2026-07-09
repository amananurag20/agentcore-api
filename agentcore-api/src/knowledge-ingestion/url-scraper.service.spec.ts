import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { UrlScraperService } from './url-scraper.service';

jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

const mockedLookup = jest.mocked(lookup);

describe('UrlScraperService', () => {
  beforeEach(() => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    jest.spyOn(global, 'fetch').mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts main content, removes boilerplate, and keeps same-origin links', async () => {
    const service = createService({
      KNOWLEDGE_URL_SCRAPER_MAX_PAGES: 2,
      KNOWLEDGE_URL_SCRAPER_RESPECT_ROBOTS: false,
      KNOWLEDGE_URL_SCRAPER_SITEMAP_ENABLED: false,
    });
    const fetchMock = jest.spyOn(global, 'fetch');

    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        'https://example.com/',
        `
          <html>
            <head><title>Fallback title</title></head>
            <body>
              <nav>Navigation that should disappear</nav>
              <main>
                <h1>Useful Product Guide</h1>
                <p>This is useful page content about pricing, services, and booking for customers.</p>
                <p>This is useful page content about pricing, services, and booking for customers.</p>
                <a href="/about?utm_source=newsletter#team">About us</a>
                <a href="https://external.example/page">External</a>
                <a href="/logo.png">Image</a>
              </main>
              <footer>Footer that should disappear</footer>
            </body>
          </html>
        `,
      ),
    );
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        'https://example.com/about',
        `
          <html>
            <body>
              <article>
                <h1>About Example</h1>
                <p>Enough customer-facing about-page content to pass the scraper usefulness threshold with service details and support information.</p>
              </article>
            </body>
          </html>
        `,
      ),
    );

    const pages = await service.scrape('https://example.com/?utm_medium=ad');

    expect(pages).toHaveLength(2);
    expect(pages[0].title).toBe('Useful Product Guide');
    expect(pages[0].text).toContain('Useful Product Guide');
    expect(pages[0].text).toContain('pricing, services, and booking');
    expect(pages[0].text).not.toContain('Navigation');
    expect(pages[0].text).not.toContain('Footer');
    expect(pages[0].links).toEqual(['https://example.com/about']);
  });

  it('blocks URLs disallowed by robots.txt', async () => {
    const service = createService({
      KNOWLEDGE_URL_SCRAPER_RESPECT_ROBOTS: true,
      KNOWLEDGE_URL_SCRAPER_SITEMAP_ENABLED: false,
    });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      textResponse(
        'https://example.com/robots.txt',
        `
          User-agent: *
          Disallow: /private
        `,
      ),
    );

    await expect(
      service.scrape('https://example.com/private/page'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('retries transient website failures', async () => {
    const service = createService({
      KNOWLEDGE_URL_SCRAPER_MAX_RETRIES: 1,
      KNOWLEDGE_URL_SCRAPER_RESPECT_ROBOTS: false,
      KNOWLEDGE_URL_SCRAPER_SITEMAP_ENABLED: false,
    });
    const fetchMock = jest.spyOn(global, 'fetch');

    fetchMock
      .mockResolvedValueOnce(textResponse('https://example.com/', 'busy', 503))
      .mockResolvedValueOnce(
        htmlResponse(
          'https://example.com/',
          '<main><h1>Recovered</h1><p>Recovered page content with enough useful words for ingestion, product details, service support, and customer policies.</p></main>',
        ),
      );

    const pages = await service.scrape('https://example.com/');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages[0].title).toBe('Recovered');
  });
});

function createService(values: Record<string, unknown>) {
  return new UrlScraperService({
    get: (key: string) => values[key],
  } as never);
}

function htmlResponse(url: string, body: string, status = 200) {
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function textResponse(url: string, body: string, status = 200) {
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}
