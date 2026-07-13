DROP INDEX IF EXISTS "customer_chat_widget_configs_organization_id_key";

ALTER TABLE "customer_chat_widget_configs"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Website Assistant',
  ADD COLUMN "knowledge_scope" TEXT NOT NULL DEFAULT 'all';

CREATE INDEX "customer_chat_widget_configs_organization_id_enabled_idx"
  ON "customer_chat_widget_configs"("organization_id", "enabled");

CREATE TABLE "customer_chat_widget_knowledge_folders" (
  "widget_config_id" TEXT NOT NULL,
  "folder_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_chat_widget_knowledge_folders_pkey"
    PRIMARY KEY ("widget_config_id", "folder_id"),
  CONSTRAINT "customer_chat_widget_knowledge_folders_widget_config_id_fkey"
    FOREIGN KEY ("widget_config_id")
    REFERENCES "customer_chat_widget_configs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_chat_widget_knowledge_folders_folder_id_fkey"
    FOREIGN KEY ("folder_id")
    REFERENCES "knowledge_folders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "customer_chat_widget_knowledge_folders_folder_id_idx"
  ON "customer_chat_widget_knowledge_folders"("folder_id");

ALTER TABLE "customer_chat_conversations"
  ADD COLUMN "widget_config_id" TEXT;

ALTER TABLE "customer_chat_conversations"
  ADD CONSTRAINT "customer_chat_conversations_widget_config_id_fkey"
  FOREIGN KEY ("widget_config_id")
  REFERENCES "customer_chat_widget_configs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "customer_chat_conversations_widget_config_id_idx"
  ON "customer_chat_conversations"("widget_config_id");
