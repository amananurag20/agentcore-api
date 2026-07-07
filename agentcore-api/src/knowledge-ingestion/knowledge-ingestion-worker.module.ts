import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.validation';
import { KnowledgeIngestionModule } from './knowledge-ingestion.module';
import { KnowledgeIngestionWorker } from './knowledge-ingestion.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    KnowledgeIngestionModule,
  ],
  providers: [KnowledgeIngestionWorker],
})
export class KnowledgeIngestionWorkerModule {}
