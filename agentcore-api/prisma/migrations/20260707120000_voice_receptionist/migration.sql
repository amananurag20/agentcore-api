CREATE TYPE "VoiceProviderType" AS ENUM ('twilio', 'sip', 'custom');
CREATE TYPE "VoiceConfigStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "VoiceCallStatus" AS ENUM ('ringing', 'in_progress', 'waiting_for_agent', 'transferred', 'voicemail', 'completed', 'failed');
CREATE TYPE "VoiceCallEventType" AS ENUM ('call_started', 'stt_partial', 'transcript', 'assistant_response', 'tts_started', 'barge_in', 'route_decision', 'transfer_requested', 'voicemail', 'call_ended', 'system');

CREATE TABLE "voice_receptionist_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "provider" "VoiceProviderType" NOT NULL DEFAULT 'twilio',
  "status" "VoiceConfigStatus" NOT NULL DEFAULT 'active',
  "name" TEXT NOT NULL,
  "phone_number" TEXT,
  "sip_domain" TEXT,
  "webhook_verify_token_encrypted" TEXT,
  "api_key_encrypted" TEXT,
  "stt_provider" TEXT,
  "stt_model" TEXT,
  "tts_provider" TEXT,
  "tts_voice" TEXT,
  "default_locale" TEXT NOT NULL DEFAULT 'en',
  "transfer_phone_number" TEXT,
  "voicemail_enabled" BOOLEAN NOT NULL DEFAULT true,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "voice_receptionist_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_calls" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "config_id" TEXT NOT NULL,
  "status" "VoiceCallStatus" NOT NULL DEFAULT 'ringing',
  "provider_call_id" TEXT,
  "from_number" TEXT,
  "to_number" TEXT,
  "caller_name" TEXT,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "assigned_agent_id" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  "last_event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "summary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_call_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "call_id" TEXT NOT NULL,
  "type" "VoiceCallEventType" NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'system',
  "content" TEXT,
  "confidence" DOUBLE PRECISION,
  "audio_url" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "voice_call_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voice_receptionist_configs_organization_id_status_idx" ON "voice_receptionist_configs"("organization_id", "status");
CREATE INDEX "voice_receptionist_configs_phone_number_idx" ON "voice_receptionist_configs"("phone_number");
CREATE UNIQUE INDEX "voice_calls_config_id_provider_call_id_key" ON "voice_calls"("config_id", "provider_call_id");
CREATE INDEX "voice_calls_organization_id_status_idx" ON "voice_calls"("organization_id", "status");
CREATE INDEX "voice_calls_assigned_agent_id_idx" ON "voice_calls"("assigned_agent_id");
CREATE INDEX "voice_calls_provider_call_id_idx" ON "voice_calls"("provider_call_id");
CREATE INDEX "voice_calls_last_event_at_idx" ON "voice_calls"("last_event_at");
CREATE INDEX "voice_call_events_organization_id_idx" ON "voice_call_events"("organization_id");
CREATE INDEX "voice_call_events_call_id_created_at_idx" ON "voice_call_events"("call_id", "created_at");
CREATE INDEX "voice_call_events_type_idx" ON "voice_call_events"("type");

ALTER TABLE "voice_receptionist_configs" ADD CONSTRAINT "voice_receptionist_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "voice_receptionist_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "voice_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
