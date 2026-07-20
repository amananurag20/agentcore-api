ALTER TABLE "ai_provider_configs" ADD COLUMN "deleted_at" TIMESTAMP(3);

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "organization_id"
    ORDER BY "updated_at" DESC, "id"
  ) AS row_number
  FROM "ai_provider_configs"
  WHERE "priority" = 0 AND "status" = 'active'
)
UPDATE "ai_provider_configs" AS provider
SET "priority" = 100
FROM ranked
WHERE provider."id" = ranked."id" AND ranked.row_number > 1;

DROP INDEX IF EXISTS "ai_provider_configs_one_active_primary_per_org";
CREATE UNIQUE INDEX "ai_provider_configs_one_active_primary_per_org"
ON "ai_provider_configs" ("organization_id")
WHERE "priority" = 0 AND "status" = 'active' AND "deleted_at" IS NULL;

ALTER TABLE "ai_provider_usage_daily"
DROP CONSTRAINT IF EXISTS "ai_provider_usage_daily_provider_config_id_fkey";
ALTER TABLE "ai_provider_usage_daily"
ADD CONSTRAINT "ai_provider_usage_daily_provider_config_id_fkey"
FOREIGN KEY ("provider_config_id") REFERENCES "ai_provider_configs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
