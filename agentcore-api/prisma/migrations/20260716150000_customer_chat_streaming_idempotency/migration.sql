ALTER TABLE "customer_chat_messages"
ADD COLUMN "client_message_id" TEXT;

CREATE UNIQUE INDEX "customer_chat_messages_conversation_id_client_message_id_key"
ON "customer_chat_messages"("conversation_id", "client_message_id");
