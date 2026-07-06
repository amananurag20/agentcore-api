import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('AgentCore API')
    .setDescription(
      'Core platform API for AgentCore: auth, organizations, product modules, AI gateway, chat, and RAG services.',
    )
    .setVersion('1.0.0')
    .addServer('/', 'Current origin')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the JWT access token returned from /auth/login.',
      },
      'bearer',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
