import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { validateEnv } from '../config/env.validation';
import { KnowledgeIngestionWorker } from './knowledge-ingestion.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    PrismaModule,
  ],
  providers: [KnowledgeIngestionWorker],
})
export class KnowledgeIngestionWorkerModule {}
