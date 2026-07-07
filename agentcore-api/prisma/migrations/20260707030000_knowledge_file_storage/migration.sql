-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('s3', 'r2', 'minio');

-- AlterTable
ALTER TABLE "knowledge_sources"
  ADD COLUMN "storage_provider" "StorageProvider",
  ADD COLUMN "storage_bucket" TEXT,
  ADD COLUMN "storage_key" TEXT,
  ADD COLUMN "file_size_bytes" BIGINT,
  ADD COLUMN "checksum_sha256" TEXT;

-- CreateIndex
CREATE INDEX "knowledge_sources_storage_provider_storage_bucket_idx"
  ON "knowledge_sources"("storage_provider", "storage_bucket");
