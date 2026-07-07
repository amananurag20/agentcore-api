-- CreateEnum
CREATE TYPE "AIProviderType" AS ENUM ('openai', 'anthropic', 'local', 'custom');

-- CreateEnum
CREATE TYPE "AIProviderStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "ai_provider_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "provider" "AIProviderType" NOT NULL,
  "status" "AIProviderStatus" NOT NULL DEFAULT 'active',
  "name" TEXT NOT NULL,
  "base_url" TEXT,
  "api_key_encrypted" TEXT,
  "chat_model" TEXT,
  "embedding_model" TEXT,
  "rerank_model" TEXT,
  "stt_model" TEXT,
  "tts_model" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_provider_configs_organization_id_status_idx"
  ON "ai_provider_configs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ai_provider_configs_provider_idx"
  ON "ai_provider_configs"("provider");

-- AddForeignKey
ALTER TABLE "ai_provider_configs"
  ADD CONSTRAINT "ai_provider_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
