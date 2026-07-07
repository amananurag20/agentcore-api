import { NestFactory } from '@nestjs/core';
import { KnowledgeIngestionWorkerModule } from './knowledge-ingestion/knowledge-ingestion-worker.module';

async function bootstrapWorker() {
  await NestFactory.createApplicationContext(KnowledgeIngestionWorkerModule);
}

void bootstrapWorker();
