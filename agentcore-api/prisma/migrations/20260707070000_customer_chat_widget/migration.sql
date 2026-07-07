-- AlterTable
ALTER TABLE "customer_chat_conversations"
  ADD COLUMN "visitor_token_hash" TEXT;

-- CreateTable
CREATE TABLE "customer_chat_widget_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "widget_key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "greeting_text" TEXT NOT NULL DEFAULT 'Hi! How can I help you today?',
  "allowed_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_chat_widget_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_chat_conversations_visitor_token_hash_idx"
  ON "customer_chat_conversations"("visitor_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "customer_chat_widget_configs_organization_id_key"
  ON "customer_chat_widget_configs"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_chat_widget_configs_widget_key_key"
  ON "customer_chat_widget_configs"("widget_key");

-- CreateIndex
CREATE INDEX "customer_chat_widget_configs_enabled_idx"
  ON "customer_chat_widget_configs"("enabled");

-- AddForeignKey
ALTER TABLE "customer_chat_widget_configs"
  ADD CONSTRAINT "customer_chat_widget_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
