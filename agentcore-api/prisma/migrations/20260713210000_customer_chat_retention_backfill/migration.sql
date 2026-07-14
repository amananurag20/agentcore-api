UPDATE "customer_chat_conversations"
SET "visitor_token_expires_at" = "created_at" + INTERVAL '24 hours'
WHERE "visitor_token_hash" IS NOT NULL
  AND "visitor_token_expires_at" IS NULL;

UPDATE "customer_chat_conversations"
SET "expires_at" = "last_message_at" + INTERVAL '90 days'
WHERE "expires_at" IS NULL;
