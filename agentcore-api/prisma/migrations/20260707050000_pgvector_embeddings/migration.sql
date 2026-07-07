-- Enable pgvector for semantic search.
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding columns. The v1 default dimension is 1536, matching
-- OpenAI text-embedding-3-small and our default configuration.
ALTER TABLE "knowledge_chunks"
  ADD COLUMN "embedding" vector(1536),
  ADD COLUMN "embedding_model" TEXT,
  ADD COLUMN "embedding_provider" "AIProviderType",
  ADD COLUMN "embedded_at" TIMESTAMP(3);

-- Keep tenant filtering cheap before vector ranking.
CREATE INDEX "knowledge_chunks_embedding_provider_idx"
  ON "knowledge_chunks"("embedding_provider");

-- Cosine-distance vector index. Lists can be tuned later with real data volume.
CREATE INDEX "knowledge_chunks_embedding_ivfflat_idx"
  ON "knowledge_chunks"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embedding" IS NOT NULL;
