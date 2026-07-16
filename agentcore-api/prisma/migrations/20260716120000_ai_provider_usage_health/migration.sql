ALTER TABLE "ai_provider_configs"
  ADD COLUMN "last_validated_at" TIMESTAMP(3),
  ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'untested',
  ADD COLUMN "validation_latency_ms" INTEGER,
  ADD COLUMN "validation_error" TEXT,
  ADD COLUMN "validated_models" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ai_provider_usage_daily" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "provider_config_id" TEXT NOT NULL,
  "usage_date" DATE NOT NULL,
  "capability" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "input_tokens" BIGINT NOT NULL DEFAULT 0,
  "output_tokens" BIGINT NOT NULL DEFAULT 0,
  "total_tokens" BIGINT NOT NULL DEFAULT 0,
  "estimated_cost_micros" BIGINT NOT NULL DEFAULT 0,
  "total_latency_ms" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_provider_usage_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_usage_daily_provider_config_id_usage_date_cap_key"
  ON "ai_provider_usage_daily"("provider_config_id", "usage_date", "capability", "model");
CREATE INDEX "ai_provider_usage_daily_organization_id_usage_date_idx"
  ON "ai_provider_usage_daily"("organization_id", "usage_date");
CREATE INDEX "ai_provider_usage_daily_provider_config_id_usage_date_idx"
  ON "ai_provider_usage_daily"("provider_config_id", "usage_date");

ALTER TABLE "ai_provider_usage_daily" ADD CONSTRAINT "ai_provider_usage_daily_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_provider_usage_daily" ADD CONSTRAINT "ai_provider_usage_daily_provider_config_id_fkey"
  FOREIGN KEY ("provider_config_id") REFERENCES "ai_provider_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
