import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.validation';
import { KnowledgeIngestionModule } from './knowledge-ingestion.module';
import { KnowledgeIngestionWorker } from './knowledge-ingestion.worker';
import { KnowledgeLifecycleService } from './knowledge-lifecycle.service';
import { KnowledgeAlertService } from './knowledge-alert.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    KnowledgeIngestionModule,
    PrismaModule,
  ],
  providers: [
    KnowledgeAlertService,
    KnowledgeIngestionWorker,
    KnowledgeLifecycleService,
  ],
})
export class KnowledgeIngestionWorkerModule {}
