-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM (
  'website_url',
  'uploaded_file',
  'text',
  'faq'
);

-- CreateEnum
CREATE TYPE "KnowledgeSourceStatus" AS ENUM (
  'pending',
  'processing',
  'ready',
  'failed'
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "type" "KnowledgeSourceType" NOT NULL,
  "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'pending',
  "name" TEXT NOT NULL,
  "url" TEXT,
  "file_name" TEXT,
  "mime_type" TEXT,
  "raw_text" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "error_message" TEXT,
  "last_ingested_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source_id" TEXT,
  "title" TEXT NOT NULL,
  "uri" TEXT,
  "content_text" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_sources_organization_id_status_idx"
  ON "knowledge_sources"("organization_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_sources_type_idx"
  ON "knowledge_sources"("type");

-- CreateIndex
CREATE INDEX "knowledge_documents_organization_id_idx"
  ON "knowledge_documents"("organization_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_source_id_idx"
  ON "knowledge_documents"("source_id");

-- AddForeignKey
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
