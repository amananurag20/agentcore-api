CREATE TYPE "LeadConsentStatus" AS ENUM ('unknown', 'granted', 'denied', 'withdrawn');
CREATE TYPE "LeadAlertType" AS ENUM ('hot_lead', 'sla_breach', 'assignment');
CREATE TYPE "LeadWebhookDeliveryStatus" AS ENUM ('pending', 'processing', 'delivered', 'retrying', 'dead');

ALTER TABLE "leads"
  ADD COLUMN "owner_id" TEXT,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "first_response_due_at" TIMESTAMP(3),
  ADD COLUMN "first_responded_at" TIMESTAMP(3),
  ADD COLUMN "sla_breached_at" TIMESTAMP(3),
  ADD COLUMN "consent_status" "LeadConsentStatus" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "consent_source" TEXT,
  ADD COLUMN "consented_at" TIMESTAMP(3),
  ADD COLUMN "retention_expires_at" TIMESTAMP(3);

ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "leads_organization_id_owner_id_status_idx" ON "leads"("organization_id", "owner_id", "status");
CREATE INDEX "leads_organization_id_first_response_due_at_first_responded_idx" ON "leads"("organization_id", "first_response_due_at", "first_responded_at");
CREATE INDEX "leads_retention_expires_at_idx" ON "leads"("retention_expires_at");

CREATE TABLE "lead_lifecycle_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_lifecycle_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "lead_lifecycle_events" ADD CONSTRAINT "lead_lifecycle_events_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "lead_lifecycle_events_organization_id_created_at_idx" ON "lead_lifecycle_events"("organization_id", "created_at");
CREATE INDEX "lead_lifecycle_events_lead_id_created_at_idx" ON "lead_lifecycle_events"("lead_id", "created_at");

CREATE TABLE "lead_alerts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "type" "LeadAlertType" NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_alerts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "lead_alerts" ADD CONSTRAINT "lead_alerts_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "lead_alerts_organization_id_read_at_created_at_idx" ON "lead_alerts"("organization_id", "read_at", "created_at");
CREATE INDEX "lead_alerts_lead_id_type_created_at_idx" ON "lead_alerts"("lead_id", "type", "created_at");

CREATE TABLE "lead_webhook_endpoints" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret_encrypted" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_webhook_endpoints_organization_id_enabled_idx" ON "lead_webhook_endpoints"("organization_id", "enabled");

CREATE TABLE "lead_webhook_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "endpoint_id" TEXT NOT NULL,
  "lead_id" TEXT,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "LeadWebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(3),
  "response_status" INTEGER,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "lead_webhook_deliveries" ADD CONSTRAINT "lead_webhook_deliveries_endpoint_id_fkey"
  FOREIGN KEY ("endpoint_id") REFERENCES "lead_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_webhook_deliveries" ADD CONSTRAINT "lead_webhook_deliveries_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "lead_webhook_deliveries_endpoint_id_event_id_key" ON "lead_webhook_deliveries"("endpoint_id", "event_id");
CREATE INDEX "lead_webhook_deliveries_status_next_attempt_at_idx" ON "lead_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "lead_webhook_deliveries_organization_id_created_at_idx" ON "lead_webhook_deliveries"("organization_id", "created_at");
