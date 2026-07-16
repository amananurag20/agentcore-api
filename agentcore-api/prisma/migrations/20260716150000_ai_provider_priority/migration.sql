ALTER TABLE "ai_provider_configs"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "organization_id"
    ORDER BY "created_at" DESC
  ) AS position
  FROM "ai_provider_configs"
  WHERE "status" = 'active'
)
UPDATE "ai_provider_configs" AS provider
SET "priority" = CASE WHEN ranked.position = 1 THEN 0 ELSE 100 END
FROM ranked
WHERE provider."id" = ranked."id";

DROP INDEX IF EXISTS "ai_provider_configs_organization_id_status_idx";
CREATE INDEX "ai_provider_configs_organization_id_status_priority_idx"
  ON "ai_provider_configs"("organization_id", "status", "priority");
