ALTER TABLE "voice_calls"
ADD COLUMN "duration_seconds" INTEGER,
ADD COLUMN "recording_sid" TEXT,
ADD COLUMN "recording_url" TEXT,
ADD COLUMN "recording_duration_seconds" INTEGER;

CREATE INDEX "voice_calls_recording_sid_idx" ON "voice_calls"("recording_sid");
