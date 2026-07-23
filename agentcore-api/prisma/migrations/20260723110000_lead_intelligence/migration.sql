CREATE TYPE "LeadPriority" AS ENUM ('low', 'medium', 'high', 'hot');

ALTER TABLE "leads"
  ADD COLUMN "priority" "LeadPriority" NOT NULL DEFAULT 'low',
  ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "automatic_score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "score_override" INTEGER,
  ADD COLUMN "qualification" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "score_updated_at" TIMESTAMP(3);

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_score_check" CHECK ("score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "leads_automatic_score_check" CHECK ("automatic_score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "leads_score_override_check" CHECK ("score_override" IS NULL OR "score_override" BETWEEN 0 AND 100);

CREATE INDEX "leads_organization_id_priority_score_idx"
  ON "leads"("organization_id", "priority", "score");

CREATE INDEX "leads_organization_id_score_last_activity_at_idx"
  ON "leads"("organization_id", "score", "last_activity_at");
