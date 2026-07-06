import { INestApplication } from '@nestjs/common';
import { apiReference } from '@scalar/nestjs-api-reference';
import { Request, Response } from 'express';
import { createOpenApiDocument } from './openapi';

export function setupApiDocs(app: INestApplication) {
  const document = createOpenApiDocument(app);
  const httpAdapter = app.getHttpAdapter();

  httpAdapter.get('/openapi.json', (_request: Request, response: Response) => {
    response.json(document);
  });

  httpAdapter.use(
    '/docs',
    apiReference({
      url: '/openapi.json',
      pageTitle: 'AgentCore API Docs',
      darkMode: false,
      hideDownloadButton: false,
    }),
  );
}
