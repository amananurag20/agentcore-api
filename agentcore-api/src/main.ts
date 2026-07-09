import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApiDocs } from './docs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  app.enableCors({
    origin: resolveCorsOrigins(configService),
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  setupApiDocs(app);

  await app.listen(configService.getOrThrow<number>('PORT'));
}
void bootstrap();

function resolveCorsOrigins(configService: ConfigService): true | string[] {
  const rawOrigins = configService.get<string>('CORS_ORIGINS');

  if (!rawOrigins || rawOrigins.trim() === '*') {
    return true;
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
