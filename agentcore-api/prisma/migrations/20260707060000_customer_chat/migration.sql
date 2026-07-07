-- CreateEnum
CREATE TYPE "CustomerChatConversationStatus" AS ENUM (
  'open',
  'waiting_for_agent',
  'closed'
);

-- CreateEnum
CREATE TYPE "CustomerChatMessageRole" AS ENUM (
  'visitor',
  'assistant',
  'agent',
  'system'
);

-- CreateTable
CREATE TABLE "customer_chat_conversations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "status" "CustomerChatConversationStatus" NOT NULL DEFAULT 'open',
  "visitor_id" TEXT,
  "visitor_name" TEXT,
  "visitor_email" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_chat_messages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "role" "CustomerChatMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_chat_citations" (
  "id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "chunk_id" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_chat_citations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_chat_conversations_organization_id_status_idx"
  ON "customer_chat_conversations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "customer_chat_conversations_visitor_id_idx"
  ON "customer_chat_conversations"("visitor_id");

-- CreateIndex
CREATE INDEX "customer_chat_messages_organization_id_idx"
  ON "customer_chat_messages"("organization_id");

-- CreateIndex
CREATE INDEX "customer_chat_messages_conversation_id_created_at_idx"
  ON "customer_chat_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_chat_citations_message_id_idx"
  ON "customer_chat_citations"("message_id");

-- CreateIndex
CREATE INDEX "customer_chat_citations_chunk_id_idx"
  ON "customer_chat_citations"("chunk_id");

-- AddForeignKey
ALTER TABLE "customer_chat_conversations"
  ADD CONSTRAINT "customer_chat_conversations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_chat_messages"
  ADD CONSTRAINT "customer_chat_messages_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_chat_messages"
  ADD CONSTRAINT "customer_chat_messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "customer_chat_conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_chat_citations"
  ADD CONSTRAINT "customer_chat_citations_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "customer_chat_messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_chat_citations"
  ADD CONSTRAINT "customer_chat_citations_chunk_id_fkey"
  FOREIGN KEY ("chunk_id") REFERENCES "knowledge_chunks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
