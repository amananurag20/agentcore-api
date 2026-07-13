CREATE TYPE "AppointmentReminderStatus" AS ENUM (
  'pending',
  'processing',
  'sent',
  'failed',
  'cancelled',
  'skipped'
);

ALTER TABLE "appointment_bookings"
ADD COLUMN "manage_token_hash" TEXT;

CREATE TABLE "appointment_reminders" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "offset_minutes" INTEGER NOT NULL,
  "reminder_type" TEXT NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "status" "AppointmentReminderStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "provider_message_ids" JSONB NOT NULL DEFAULT '{}',
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointment_reminders_booking_id_offset_minutes_key"
ON "appointment_reminders"("booking_id", "offset_minutes");

CREATE INDEX "appointment_reminders_organization_id_status_due_at_idx"
ON "appointment_reminders"("organization_id", "status", "due_at");

CREATE INDEX "appointment_reminders_booking_id_status_idx"
ON "appointment_reminders"("booking_id", "status");

ALTER TABLE "appointment_reminders"
ADD CONSTRAINT "appointment_reminders_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_reminders"
ADD CONSTRAINT "appointment_reminders_booking_id_fkey"
FOREIGN KEY ("booking_id") REFERENCES "appointment_bookings"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
