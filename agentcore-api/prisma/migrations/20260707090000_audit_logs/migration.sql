CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT,
  "actor_user_id" TEXT,
  "actor_email" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_organization_id_created_at_idx"
ON "audit_logs"("organization_id", "created_at");

CREATE INDEX "audit_logs_actor_user_id_created_at_idx"
ON "audit_logs"("actor_user_id", "created_at");

CREATE INDEX "audit_logs_action_idx"
ON "audit_logs"("action");

CREATE INDEX "audit_logs_entity_type_entity_id_idx"
ON "audit_logs"("entity_type", "entity_id");
