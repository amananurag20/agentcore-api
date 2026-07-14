ALTER TABLE "whatsapp_messages"
ADD COLUMN "delivery_status" TEXT,
ADD COLUMN "delivery_error" TEXT,
ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "delivered_at" TIMESTAMP(3);

CREATE INDEX "whatsapp_messages_organization_id_delivery_status_idx"
ON "whatsapp_messages"("organization_id", "delivery_status");
