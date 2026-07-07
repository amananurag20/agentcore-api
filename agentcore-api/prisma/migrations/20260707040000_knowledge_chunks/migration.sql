-- CreateTable
CREATE TABLE "knowledge_chunks" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source_id" TEXT,
  "document_id" TEXT NOT NULL,
  "chunk_index" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "char_count" INTEGER NOT NULL,
  "token_estimate" INTEGER NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_document_id_chunk_index_key"
  ON "knowledge_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "knowledge_chunks_organization_id_idx"
  ON "knowledge_chunks"("organization_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_source_id_idx"
  ON "knowledge_chunks"("source_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_document_id_idx"
  ON "knowledge_chunks"("document_id");

-- AddForeignKey
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
