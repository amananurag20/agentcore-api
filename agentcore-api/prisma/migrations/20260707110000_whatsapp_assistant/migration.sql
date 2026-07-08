CREATE TYPE "WhatsAppProviderType" AS ENUM ('meta', 'twilio', 'custom');
CREATE TYPE "WhatsAppConfigStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "WhatsAppConversationStatus" AS ENUM (
  'open',
  'waiting_for_agent',
  'closed'
);
CREATE TYPE "WhatsAppMessageDirection" AS ENUM ('inbound', 'outbound');
CREATE TYPE "WhatsAppMessageRole" AS ENUM (
  'contact',
  'assistant',
  'agent',
  'system'
);
CREATE TYPE "WhatsAppMessageType" AS ENUM (
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'unknown'
);

CREATE TABLE "whatsapp_assistant_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "provider" "WhatsAppProviderType" NOT NULL DEFAULT 'meta',
  "status" "WhatsAppConfigStatus" NOT NULL DEFAULT 'active',
  "name" TEXT NOT NULL,
  "phone_number_id" TEXT,
  "business_account_id" TEXT,
  "access_token_encrypted" TEXT,
  "webhook_verify_token_encrypted" TEXT,
  "app_secret_encrypted" TEXT,
  "default_locale" TEXT NOT NULL DEFAULT 'en',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_assistant_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_conversations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "config_id" TEXT NOT NULL,
  "status" "WhatsAppConversationStatus" NOT NULL DEFAULT 'open',
  "contact_wa_id" TEXT NOT NULL,
  "contact_name" TEXT,
  "contact_phone" TEXT,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "assigned_agent_id" TEXT,
  "session_expires_at" TIMESTAMP(3),
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_messages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "direction" "WhatsAppMessageDirection" NOT NULL,
  "role" "WhatsAppMessageRole" NOT NULL,
  "type" "WhatsAppMessageType" NOT NULL DEFAULT 'text',
  "provider_message_id" TEXT,
  "content" TEXT,
  "media_url" TEXT,
  "media_mime_type" TEXT,
  "media_sha256" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_assistant_configs_organization_id_status_idx"
ON "whatsapp_assistant_configs"("organization_id", "status");

CREATE INDEX "whatsapp_assistant_configs_phone_number_id_idx"
ON "whatsapp_assistant_configs"("phone_number_id");

CREATE UNIQUE INDEX "whatsapp_conversations_config_id_contact_wa_id_key"
ON "whatsapp_conversations"("config_id", "contact_wa_id");

CREATE INDEX "whatsapp_conversations_organization_id_status_idx"
ON "whatsapp_conversations"("organization_id", "status");

CREATE INDEX "whatsapp_conversations_assigned_agent_id_idx"
ON "whatsapp_conversations"("assigned_agent_id");

CREATE INDEX "whatsapp_conversations_contact_wa_id_idx"
ON "whatsapp_conversations"("contact_wa_id");

CREATE INDEX "whatsapp_conversations_last_message_at_idx"
ON "whatsapp_conversations"("last_message_at");

CREATE INDEX "whatsapp_messages_organization_id_idx"
ON "whatsapp_messages"("organization_id");

CREATE INDEX "whatsapp_messages_conversation_id_created_at_idx"
ON "whatsapp_messages"("conversation_id", "created_at");

CREATE INDEX "whatsapp_messages_provider_message_id_idx"
ON "whatsapp_messages"("provider_message_id");

ALTER TABLE "whatsapp_assistant_configs"
ADD CONSTRAINT "whatsapp_assistant_configs_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
ADD CONSTRAINT "whatsapp_conversations_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
ADD CONSTRAINT "whatsapp_conversations_config_id_fkey"
FOREIGN KEY ("config_id") REFERENCES "whatsapp_assistant_configs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
ADD CONSTRAINT "whatsapp_conversations_assigned_agent_id_fkey"
FOREIGN KEY ("assigned_agent_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_messages"
ADD CONSTRAINT "whatsapp_messages_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_messages"
ADD CONSTRAINT "whatsapp_messages_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "whatsapp_conversations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
