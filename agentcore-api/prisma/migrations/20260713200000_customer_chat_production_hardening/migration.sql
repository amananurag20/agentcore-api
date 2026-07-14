ALTER TABLE "customer_chat_conversations"
  ADD COLUMN "visitor_token_expires_at" TIMESTAMP(3),
  ADD COLUMN "handoff_requested_at" TIMESTAMP(3),
  ADD COLUMN "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "expires_at" TIMESTAMP(3);

CREATE INDEX "customer_chat_conversations_organization_id_last_message_at_idx"
  ON "customer_chat_conversations"("organization_id", "last_message_at");

CREATE INDEX "customer_chat_conversations_expires_at_idx"
  ON "customer_chat_conversations"("expires_at");
