ALTER TABLE "appointment_services"
  ADD COLUMN "reminder_offsets_minutes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "reminder_templates" JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE "appointment_booking_policies"
  ADD COLUMN "reminder_offsets_minutes" INTEGER[] NOT NULL DEFAULT ARRAY[1440, 60]::INTEGER[],
  ADD COLUMN "reminder_templates" JSONB NOT NULL DEFAULT '{}'::JSONB;
