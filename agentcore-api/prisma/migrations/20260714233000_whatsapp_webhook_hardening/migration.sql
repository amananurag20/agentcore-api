ALTER TABLE "whatsapp_messages"
  ADD COLUMN "processed_at" TIMESTAMP(3),
  ADD COLUMN "processing_error" TEXT,
  ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "whatsapp_messages_provider_message_id_idx";

WITH duplicate_messages AS (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "organization_id", "direction", "provider_message_id"
        ORDER BY "created_at", "id"
      ) AS duplicate_rank
    FROM "whatsapp_messages"
    WHERE "provider_message_id" IS NOT NULL
  ) ranked
  WHERE duplicate_rank > 1
)
UPDATE "whatsapp_messages"
SET "provider_message_id" = NULL
WHERE "id" IN (SELECT "id" FROM duplicate_messages);

CREATE UNIQUE INDEX "whatsapp_messages_organization_id_direction_provider_message_id_key"
  ON "whatsapp_messages"("organization_id", "direction", "provider_message_id");

CREATE INDEX "whatsapp_messages_processed_at_idx"
  ON "whatsapp_messages"("processed_at");
