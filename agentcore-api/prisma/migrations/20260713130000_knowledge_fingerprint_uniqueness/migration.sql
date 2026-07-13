DROP INDEX "knowledge_sources_organization_id_content_fingerprint_idx";
CREATE UNIQUE INDEX "knowledge_sources_organization_id_content_fingerprint_key"
  ON "knowledge_sources"("organization_id", "content_fingerprint");
