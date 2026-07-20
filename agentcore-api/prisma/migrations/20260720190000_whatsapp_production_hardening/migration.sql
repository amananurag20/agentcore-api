CREATE TYPE "WhatsAppConsentStatus" AS ENUM ('unknown', 'opted_in', 'opted_out');

ALTER TYPE "WhatsAppMessageType" ADD VALUE IF NOT EXISTS 'interactive';
ALTER TYPE "WhatsAppMessageType" ADD VALUE IF NOT EXISTS 'contact';
ALTER TYPE "WhatsAppMessageType" ADD VALUE IF NOT EXISTS 'reaction';

ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "consent_status" "WhatsAppConsentStatus" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "consent_source" TEXT,
  ADD COLUMN "consented_at" TIMESTAMP(3),
  ADD COLUMN "opted_out_at" TIMESTAMP(3),
  ADD COLUMN "processing_lease_message_id" TEXT,
  ADD COLUMN "processing_lease_expires_at" TIMESTAMP(3);

ALTER TABLE "whatsapp_messages"
  ADD COLUMN "automation_key" TEXT;

CREATE UNIQUE INDEX "whatsapp_messages_automation_key_key"
  ON "whatsapp_messages"("automation_key");

CREATE TABLE "whatsapp_pending_delivery_statuses" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "provider_message_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "callback_at" TIMESTAMP(3) NOT NULL,
  "recipient_wa_id" TEXT,
  "errors" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_pending_delivery_statuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_pending_delivery_statuses_organization_id_provider_message_id_key"
  ON "whatsapp_pending_delivery_statuses"("organization_id", "provider_message_id");
CREATE INDEX "whatsapp_pending_delivery_statuses_created_at_idx"
  ON "whatsapp_pending_delivery_statuses"("created_at");

ALTER TABLE "whatsapp_pending_delivery_statuses"
  ADD CONSTRAINT "whatsapp_pending_delivery_statuses_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
