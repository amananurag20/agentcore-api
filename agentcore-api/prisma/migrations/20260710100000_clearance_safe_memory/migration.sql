ALTER TABLE "knowledge_sources"
ADD COLUMN "sensitivity_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "level_source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "product_visibility" "ProductKey"[] NOT NULL DEFAULT ARRAY['customer_chat', 'appointment_booking', 'whatsapp_assistant', 'voice_receptionist']::"ProductKey"[],
ADD COLUMN "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "is_quarantined" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "knowledge_documents"
ADD COLUMN "sensitivity_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "product_visibility" "ProductKey"[] NOT NULL DEFAULT ARRAY['customer_chat', 'appointment_booking', 'whatsapp_assistant', 'voice_receptionist']::"ProductKey"[],
ADD COLUMN "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "is_quarantined" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "knowledge_chunks"
ADD COLUMN "sensitivity_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "product_visibility" "ProductKey"[] NOT NULL DEFAULT ARRAY['customer_chat', 'appointment_booking', 'whatsapp_assistant', 'voice_receptionist']::"ProductKey"[],
ADD COLUMN "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "is_quarantined" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "knowledge_chunks_organization_id_idx";
CREATE INDEX "knowledge_chunks_organization_id_sensitivity_level_is_quarantined_idx"
ON "knowledge_chunks"("organization_id", "sensitivity_level", "is_quarantined");

ALTER TABLE "knowledge_sources"
ADD CONSTRAINT "knowledge_sources_sensitivity_level_check"
CHECK ("sensitivity_level" BETWEEN 0 AND 4);

ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_sensitivity_level_check"
CHECK ("sensitivity_level" BETWEEN 0 AND 4);

ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_sensitivity_level_check"
CHECK ("sensitivity_level" BETWEEN 0 AND 4);

ALTER TABLE "users"
ADD CONSTRAINT "users_clearance_level_check"
CHECK ("clearance_level" BETWEEN 0 AND 4);
