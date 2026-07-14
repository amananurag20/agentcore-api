ALTER TYPE "WhatsAppMessageType" ADD VALUE IF NOT EXISTS 'template';

ALTER TABLE "whatsapp_messages"
  ADD COLUMN "media_storage_bucket" TEXT,
  ADD COLUMN "media_storage_key" TEXT,
  ADD COLUMN "media_size_bytes" INTEGER;

CREATE TABLE "whatsapp_templates" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "config_id" TEXT NOT NULL,
  "provider_template_id" TEXT,
  "name" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "category" TEXT,
  "components" JSONB NOT NULL DEFAULT '[]',
  "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_templates_config_id_name_language_key"
  ON "whatsapp_templates"("config_id", "name", "language");
CREATE INDEX "whatsapp_templates_organization_id_status_idx"
  ON "whatsapp_templates"("organization_id", "status");
CREATE INDEX "whatsapp_templates_config_id_language_status_idx"
  ON "whatsapp_templates"("config_id", "language", "status");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "whatsapp_assistant_configs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
