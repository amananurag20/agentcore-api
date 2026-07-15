CREATE TABLE "knowledge_ocr_page_cache" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "page_fingerprint" TEXT NOT NULL,
  "pipeline_signature" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "confidence" DOUBLE PRECISION,
  "text" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "hit_count" INTEGER NOT NULL DEFAULT 0,
  "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_ocr_page_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_ocr_page_cache_org_fingerprint_pipeline_key"
  ON "knowledge_ocr_page_cache"("organization_id", "page_fingerprint", "pipeline_signature");
CREATE INDEX "knowledge_ocr_page_cache_org_last_accessed_idx"
  ON "knowledge_ocr_page_cache"("organization_id", "last_accessed_at");
CREATE INDEX "knowledge_ocr_page_cache_last_accessed_idx"
  ON "knowledge_ocr_page_cache"("last_accessed_at");

ALTER TABLE "knowledge_ocr_page_cache"
  ADD CONSTRAINT "knowledge_ocr_page_cache_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_ocr_page_cache"
  ADD CONSTRAINT "knowledge_ocr_page_cache_confidence_check"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "knowledge_ocr_page_cache"
  ADD CONSTRAINT "knowledge_ocr_page_cache_hit_count_check"
  CHECK ("hit_count" >= 0);
