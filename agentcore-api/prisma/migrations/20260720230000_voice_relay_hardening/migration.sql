CREATE TABLE "voice_relay_tickets" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "config_id" TEXT NOT NULL,
  "provider_call_id" TEXT NOT NULL,
  "nonce_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "connection_id" TEXT,
  "claimed_at" TIMESTAMP(3),
  "claim_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_relay_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_relay_tickets_nonce_hash_key"
  ON "voice_relay_tickets"("nonce_hash");
CREATE UNIQUE INDEX "voice_relay_tickets_config_id_provider_call_id_key"
  ON "voice_relay_tickets"("config_id", "provider_call_id");
CREATE INDEX "voice_relay_tickets_config_id_expires_at_idx"
  ON "voice_relay_tickets"("config_id", "expires_at");
CREATE INDEX "voice_relay_tickets_provider_call_id_idx"
  ON "voice_relay_tickets"("provider_call_id");

ALTER TABLE "voice_relay_tickets"
  ADD CONSTRAINT "voice_relay_tickets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_calls"
  ADD COLUMN "recording_url_encrypted" TEXT;
ALTER TABLE "voice_call_events"
  ADD COLUMN "content_encrypted" TEXT,
  ADD COLUMN "audio_url_encrypted" TEXT;
ALTER TABLE "voice_relay_tickets"
  ADD CONSTRAINT "voice_relay_tickets_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "voice_receptionist_configs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
