CREATE TYPE "KnowledgeOcrMode" AS ENUM ('disabled', 'fallback', 'always');
CREATE TYPE "KnowledgeOcrProviderType" AS ENUM ('local_tesseract', 'aws_textract', 'google_document_ai', 'azure_document_intelligence', 'custom');
CREATE TYPE "KnowledgeOcrProviderStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "knowledge_ocr_provider_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" "KnowledgeOcrProviderType" NOT NULL,
  "status" "KnowledgeOcrProviderStatus" NOT NULL DEFAULT 'active',
  "endpoint" TEXT NOT NULL,
  "api_key_encrypted" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_ocr_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_extraction_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "ocr_mode" "KnowledgeOcrMode" NOT NULL DEFAULT 'fallback',
  "primary_ocr_provider_id" TEXT,
  "fallback_ocr_provider_id" TEXT,
  "embedding_provider_id" TEXT,
  "native_text_min_characters" INTEGER NOT NULL DEFAULT 40,
  "native_text_min_alphanumeric_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "ocr_min_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
  "ocr_timeout_ms" INTEGER NOT NULL DEFAULT 60000,
  "ocr_max_retries" INTEGER NOT NULL DEFAULT 2,
  "ocr_page_concurrency" INTEGER NOT NULL DEFAULT 4,
  "ocr_render_width" INTEGER NOT NULL DEFAULT 1800,
  "max_pdf_pages" INTEGER NOT NULL DEFAULT 5000,
  "max_extracted_characters" INTEGER NOT NULL DEFAULT 25000000,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_extraction_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_ocr_provider_configs_organization_id_name_key"
  ON "knowledge_ocr_provider_configs"("organization_id", "name");
CREATE INDEX "knowledge_ocr_provider_configs_organization_id_status_idx"
  ON "knowledge_ocr_provider_configs"("organization_id", "status");
CREATE INDEX "knowledge_ocr_provider_configs_provider_idx"
  ON "knowledge_ocr_provider_configs"("provider");
CREATE UNIQUE INDEX "knowledge_extraction_configs_organization_id_key"
  ON "knowledge_extraction_configs"("organization_id");
CREATE INDEX "knowledge_extraction_configs_primary_ocr_provider_id_idx"
  ON "knowledge_extraction_configs"("primary_ocr_provider_id");
CREATE INDEX "knowledge_extraction_configs_fallback_ocr_provider_id_idx"
  ON "knowledge_extraction_configs"("fallback_ocr_provider_id");
CREATE INDEX "knowledge_extraction_configs_embedding_provider_id_idx"
  ON "knowledge_extraction_configs"("embedding_provider_id");

ALTER TABLE "knowledge_ocr_provider_configs"
  ADD CONSTRAINT "knowledge_ocr_provider_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_extraction_configs"
  ADD CONSTRAINT "knowledge_extraction_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_extraction_configs"
  ADD CONSTRAINT "knowledge_extraction_configs_primary_ocr_provider_id_fkey"
  FOREIGN KEY ("primary_ocr_provider_id") REFERENCES "knowledge_ocr_provider_configs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "knowledge_extraction_configs"
  ADD CONSTRAINT "knowledge_extraction_configs_fallback_ocr_provider_id_fkey"
  FOREIGN KEY ("fallback_ocr_provider_id") REFERENCES "knowledge_ocr_provider_configs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "knowledge_extraction_configs"
  ADD CONSTRAINT "knowledge_extraction_configs_embedding_provider_id_fkey"
  FOREIGN KEY ("embedding_provider_id") REFERENCES "ai_provider_configs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "knowledge_extraction_configs"
  ADD CONSTRAINT "knowledge_extraction_native_characters_check"
  CHECK ("native_text_min_characters" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "knowledge_extraction_native_ratio_check"
  CHECK ("native_text_min_alphanumeric_ratio" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_extraction_ocr_confidence_check"
  CHECK ("ocr_min_confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_extraction_ocr_timeout_check"
  CHECK ("ocr_timeout_ms" BETWEEN 1000 AND 300000),
  ADD CONSTRAINT "knowledge_extraction_ocr_retries_check"
  CHECK ("ocr_max_retries" BETWEEN 0 AND 5),
  ADD CONSTRAINT "knowledge_extraction_concurrency_check"
  CHECK ("ocr_page_concurrency" BETWEEN 1 AND 32),
  ADD CONSTRAINT "knowledge_extraction_render_width_check"
  CHECK ("ocr_render_width" BETWEEN 800 AND 4000),
  ADD CONSTRAINT "knowledge_extraction_max_pages_check"
  CHECK ("max_pdf_pages" BETWEEN 1 AND 20000),
  ADD CONSTRAINT "knowledge_extraction_max_characters_check"
  CHECK ("max_extracted_characters" BETWEEN 1000 AND 50000000),
  ADD CONSTRAINT "knowledge_extraction_distinct_ocr_providers_check"
  CHECK ("primary_ocr_provider_id" IS NULL OR "fallback_ocr_provider_id" IS NULL OR "primary_ocr_provider_id" <> "fallback_ocr_provider_id");
