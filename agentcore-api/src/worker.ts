import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrapWorker() {
  await NestFactory.createApplicationContext(WorkerModule);
}

void bootstrapWorker();
