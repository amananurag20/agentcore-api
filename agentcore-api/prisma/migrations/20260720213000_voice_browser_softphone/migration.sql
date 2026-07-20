CREATE TYPE "VoiceAgentAvailability" AS ENUM ('offline', 'available', 'busy');

CREATE TABLE "voice_agent_presences" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "client_identity" TEXT NOT NULL,
  "availability" "VoiceAgentAvailability" NOT NULL DEFAULT 'offline',
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active_call_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_agent_presences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_agent_presences_user_id_key"
  ON "voice_agent_presences"("user_id");
CREATE UNIQUE INDEX "voice_agent_presences_client_identity_key"
  ON "voice_agent_presences"("client_identity");
CREATE INDEX "voice_agent_presences_organization_id_availability_last_seen_at_idx"
  ON "voice_agent_presences"("organization_id", "availability", "last_seen_at");
CREATE INDEX "voice_agent_presences_active_call_id_idx"
  ON "voice_agent_presences"("active_call_id");

ALTER TABLE "voice_agent_presences"
  ADD CONSTRAINT "voice_agent_presences_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_agent_presences"
  ADD CONSTRAINT "voice_agent_presences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
