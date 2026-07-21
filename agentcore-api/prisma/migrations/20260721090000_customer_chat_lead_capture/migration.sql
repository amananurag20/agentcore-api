CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'converted', 'disqualified', 'archived');
CREATE TYPE "LeadCaptureFieldType" AS ENUM ('text', 'email', 'phone', 'number', 'textarea', 'select', 'radio', 'checkbox');
CREATE TYPE "LeadCaptureFieldMapping" AS ENUM ('name', 'email', 'phone', 'custom');

CREATE TABLE "customer_chat_lead_fields" (
    "id" TEXT NOT NULL,
    "widget_config_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "LeadCaptureFieldType" NOT NULL,
    "mapping" "LeadCaptureFieldMapping" NOT NULL DEFAULT 'custom',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "placeholder" TEXT,
    "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_chat_lead_fields_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "widget_config_id" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "name" TEXT,
    "email" TEXT,
    "normalized_email" TEXT,
    "phone" TEXT,
    "normalized_phone" TEXT,
    "visitor_id" TEXT,
    "field_values" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "customer_chat_conversations" ADD COLUMN "lead_id" TEXT;

CREATE UNIQUE INDEX "customer_chat_lead_fields_widget_config_id_key_key" ON "customer_chat_lead_fields"("widget_config_id", "key");
CREATE INDEX "customer_chat_lead_fields_widget_config_id_enabled_position_idx" ON "customer_chat_lead_fields"("widget_config_id", "enabled", "position");
CREATE UNIQUE INDEX "leads_organization_id_normalized_email_key" ON "leads"("organization_id", "normalized_email");
CREATE UNIQUE INDEX "leads_organization_id_normalized_phone_key" ON "leads"("organization_id", "normalized_phone");
CREATE INDEX "leads_organization_id_status_last_activity_at_idx" ON "leads"("organization_id", "status", "last_activity_at");
CREATE INDEX "leads_organization_id_name_idx" ON "leads"("organization_id", "name");
CREATE INDEX "leads_widget_config_id_idx" ON "leads"("widget_config_id");
CREATE INDEX "customer_chat_conversations_lead_id_idx" ON "customer_chat_conversations"("lead_id");

ALTER TABLE "customer_chat_lead_fields" ADD CONSTRAINT "customer_chat_lead_fields_widget_config_id_fkey" FOREIGN KEY ("widget_config_id") REFERENCES "customer_chat_widget_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_widget_config_id_fkey" FOREIGN KEY ("widget_config_id") REFERENCES "customer_chat_widget_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customer_chat_conversations" ADD CONSTRAINT "customer_chat_conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
