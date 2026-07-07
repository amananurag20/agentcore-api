ALTER TABLE "customer_chat_conversations"
ADD COLUMN "assigned_agent_id" TEXT;

ALTER TABLE "customer_chat_conversations"
ADD CONSTRAINT "customer_chat_conversations_assigned_agent_id_fkey"
FOREIGN KEY ("assigned_agent_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "customer_chat_conversations_assigned_agent_id_idx"
ON "customer_chat_conversations"("assigned_agent_id");
