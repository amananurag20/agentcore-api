CREATE TYPE "KnowledgeIngestionRunStatus" AS ENUM (
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'dead_letter'
);

CREATE TABLE "knowledge_ingestion_runs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "queue_job_id" TEXT,
  "reason" TEXT NOT NULL,
  "status" "KnowledgeIngestionRunStatus" NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "progress_percent" INTEGER NOT NULL DEFAULT 0,
  "processed_items" INTEGER NOT NULL DEFAULT 0,
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "cancellation_requested_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "error_message" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_ingestion_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_ingestion_runs_progress_check" CHECK ("progress_percent" BETWEEN 0 AND 100),
  CONSTRAINT "knowledge_ingestion_runs_counts_check" CHECK ("processed_items" >= 0 AND "total_items" >= 0)
);

CREATE UNIQUE INDEX "knowledge_ingestion_runs_queue_job_id_key" ON "knowledge_ingestion_runs"("queue_job_id");
CREATE INDEX "knowledge_ingestion_runs_organization_id_status_created_at_idx" ON "knowledge_ingestion_runs"("organization_id", "status", "created_at");
CREATE INDEX "knowledge_ingestion_runs_source_id_created_at_idx" ON "knowledge_ingestion_runs"("source_id", "created_at");
CREATE INDEX "knowledge_ingestion_runs_status_updated_at_idx" ON "knowledge_ingestion_runs"("status", "updated_at");

ALTER TABLE "knowledge_ingestion_runs" ADD CONSTRAINT "knowledge_ingestion_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_ingestion_runs" ADD CONSTRAINT "knowledge_ingestion_runs_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
