ALTER TABLE "knowledge_sources"
  ADD COLUMN "content_fingerprint" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "malware_scan_status" TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN "malware_scan_message" TEXT,
  ADD COLUMN "recrawl_interval_hours" INTEGER,
  ADD COLUMN "last_crawled_at" TIMESTAMP(3),
  ADD COLUMN "next_crawl_at" TIMESTAMP(3),
  ADD COLUMN "stale_after_at" TIMESTAMP(3);

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_recrawl_interval_hours_check"
  CHECK ("recrawl_interval_hours" IS NULL OR "recrawl_interval_hours" BETWEEN 1 AND 8760);

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_version_check"
  CHECK ("version" >= 0);

CREATE INDEX "knowledge_sources_organization_id_content_fingerprint_idx"
  ON "knowledge_sources"("organization_id", "content_fingerprint");
CREATE INDEX "knowledge_sources_type_next_crawl_at_idx"
  ON "knowledge_sources"("type", "next_crawl_at");
CREATE INDEX "knowledge_sources_stale_after_at_idx"
  ON "knowledge_sources"("stale_after_at");

CREATE TABLE "knowledge_source_versions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content_fingerprint" TEXT NOT NULL,
  "content_text" TEXT NOT NULL,
  "document_count" INTEGER NOT NULL,
  "chunk_count" INTEGER NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_source_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_source_versions_source_id_version_key"
  ON "knowledge_source_versions"("source_id", "version");
CREATE INDEX "knowledge_source_versions_organization_id_created_at_idx"
  ON "knowledge_source_versions"("organization_id", "created_at");
CREATE INDEX "knowledge_source_versions_source_id_created_at_idx"
  ON "knowledge_source_versions"("source_id", "created_at");

ALTER TABLE "knowledge_source_versions"
  ADD CONSTRAINT "knowledge_source_versions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_source_versions"
  ADD CONSTRAINT "knowledge_source_versions_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
