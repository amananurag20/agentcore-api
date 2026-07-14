CREATE TYPE "AppointmentRecurrenceFrequency" AS ENUM ('daily', 'weekly', 'monthly');
CREATE TYPE "AppointmentRecurrenceSeriesStatus" AS ENUM ('active', 'cancelled', 'completed');
CREATE TYPE "AppointmentWaitlistStatus" AS ENUM ('waiting', 'offered', 'claimed', 'expired', 'cancelled');
CREATE TYPE "AppointmentReminderChannel" AS ENUM ('email', 'sms', 'whatsapp');

ALTER TABLE "appointment_services"
  ADD COLUMN "max_attendees" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cancellation_window_minutes" INTEGER,
  ADD COLUMN "reschedule_window_minutes" INTEGER,
  ADD COLUMN "waitlist_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "appointment_services_max_attendees_check" CHECK ("max_attendees" > 0),
  ADD CONSTRAINT "appointment_services_cancellation_window_check" CHECK ("cancellation_window_minutes" IS NULL OR "cancellation_window_minutes" >= 0),
  ADD CONSTRAINT "appointment_services_reschedule_window_check" CHECK ("reschedule_window_minutes" IS NULL OR "reschedule_window_minutes" >= 0);

ALTER TABLE "appointment_bookings"
  ADD COLUMN "party_size" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "is_group_booking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "checked_in_at" TIMESTAMP(3),
  ADD COLUMN "series_id" TEXT,
  ADD COLUMN "occurrence_index" INTEGER,
  ADD CONSTRAINT "appointment_bookings_party_size_check" CHECK ("party_size" > 0);

ALTER TABLE "appointment_bookings"
  DROP CONSTRAINT IF EXISTS "appointment_bookings_active_staff_no_overlap";

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_active_staff_no_overlap"
EXCLUDE USING gist (
  "organization_id" WITH =,
  "staff_id" WITH =,
  tsrange("start_at", "end_at", '[)') WITH &&
)
WHERE ("status" IN ('pending', 'confirmed') AND NOT "is_group_booking");

CREATE TABLE "appointment_booking_policies" (
  "organization_id" TEXT NOT NULL,
  "cancellation_window_minutes" INTEGER NOT NULL DEFAULT 0,
  "reschedule_window_minutes" INTEGER NOT NULL DEFAULT 0,
  "no_show_grace_minutes" INTEGER NOT NULL DEFAULT 30,
  "waitlist_offer_minutes" INTEGER NOT NULL DEFAULT 15,
  "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  "quiet_hours_start" TEXT NOT NULL DEFAULT '21:00',
  "quiet_hours_end" TEXT NOT NULL DEFAULT '08:00',
  "quiet_hours_timezone" TEXT NOT NULL DEFAULT 'UTC',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_booking_policies_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "appointment_booking_policies_nonnegative_check" CHECK (
    "cancellation_window_minutes" >= 0 AND
    "reschedule_window_minutes" >= 0 AND
    "no_show_grace_minutes" >= 0 AND
    "waitlist_offer_minutes" > 0
  )
);

CREATE TABLE "appointment_blackouts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "annual" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_blackouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_blackouts_range_check" CHECK ("end_at" > "start_at")
);

CREATE TABLE "appointment_recurrence_series" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "frequency" "AppointmentRecurrenceFrequency" NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  "occurrence_count" INTEGER NOT NULL,
  "initial_start_at" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "customer_name" TEXT NOT NULL,
  "customer_email" TEXT,
  "customer_phone" TEXT,
  "party_size" INTEGER NOT NULL DEFAULT 1,
  "notes" TEXT,
  "status" "AppointmentRecurrenceSeriesStatus" NOT NULL DEFAULT 'active',
  "manage_token_hash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_recurrence_series_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_recurrence_series_values_check" CHECK ("interval" > 0 AND "occurrence_count" BETWEEN 2 AND 52 AND "party_size" > 0)
);

ALTER TABLE "appointment_bookings"
  ADD CONSTRAINT "appointment_bookings_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "appointment_recurrence_series"("id") ON DELETE SET NULL;

CREATE TABLE "appointment_waitlist_entries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "customer_name" TEXT NOT NULL,
  "customer_email" TEXT,
  "customer_phone" TEXT,
  "party_size" INTEGER NOT NULL DEFAULT 1,
  "status" "AppointmentWaitlistStatus" NOT NULL DEFAULT 'waiting',
  "position" INTEGER NOT NULL,
  "offer_token_hash" TEXT,
  "offer_expires_at" TIMESTAMP(3),
  "claimed_booking_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_waitlist_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_waitlist_entries_party_size_check" CHECK ("party_size" > 0),
  CONSTRAINT "appointment_waitlist_entries_contact_check" CHECK ("customer_email" IS NOT NULL OR "customer_phone" IS NOT NULL)
);

CREATE TABLE "appointment_reminder_suppressions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "channel" "AppointmentReminderChannel" NOT NULL,
  "contact_normalized" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_reminder_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointment_waitlist_entries_claimed_booking_id_key" ON "appointment_waitlist_entries"("claimed_booking_id");
CREATE UNIQUE INDEX "appointment_waitlist_entries_offer_token_hash_key" ON "appointment_waitlist_entries"("offer_token_hash");
CREATE UNIQUE INDEX "appointment_waitlist_entries_slot_contact_key" ON "appointment_waitlist_entries"("service_id", "staff_id", "start_at", "customer_email", "customer_phone");
CREATE INDEX "appointment_waitlist_entries_organization_id_status_start_at_idx" ON "appointment_waitlist_entries"("organization_id", "status", "start_at");
CREATE INDEX "appointment_waitlist_entries_slot_position_idx" ON "appointment_waitlist_entries"("service_id", "staff_id", "start_at", "position");
CREATE UNIQUE INDEX "appointment_reminder_suppressions_contact_key" ON "appointment_reminder_suppressions"("organization_id", "channel", "contact_normalized");
CREATE INDEX "appointment_reminder_suppressions_lookup_idx" ON "appointment_reminder_suppressions"("organization_id", "contact_normalized");
CREATE INDEX "appointment_blackouts_organization_id_start_at_end_at_idx" ON "appointment_blackouts"("organization_id", "start_at", "end_at");
CREATE INDEX "appointment_recurrence_series_organization_id_status_idx" ON "appointment_recurrence_series"("organization_id", "status");
CREATE INDEX "appointment_recurrence_series_staff_id_initial_start_at_idx" ON "appointment_recurrence_series"("staff_id", "initial_start_at");
CREATE INDEX "appointment_bookings_series_id_occurrence_index_idx" ON "appointment_bookings"("series_id", "occurrence_index");

ALTER TABLE "appointment_booking_policies" ADD CONSTRAINT "appointment_booking_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_blackouts" ADD CONSTRAINT "appointment_blackouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_recurrence_series" ADD CONSTRAINT "appointment_recurrence_series_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_recurrence_series" ADD CONSTRAINT "appointment_recurrence_series_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "appointment_services"("id") ON DELETE RESTRICT;
ALTER TABLE "appointment_recurrence_series" ADD CONSTRAINT "appointment_recurrence_series_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id") ON DELETE RESTRICT;
ALTER TABLE "appointment_waitlist_entries" ADD CONSTRAINT "appointment_waitlist_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_waitlist_entries" ADD CONSTRAINT "appointment_waitlist_entries_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "appointment_services"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_waitlist_entries" ADD CONSTRAINT "appointment_waitlist_entries_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_waitlist_entries" ADD CONSTRAINT "appointment_waitlist_entries_claimed_booking_id_fkey" FOREIGN KEY ("claimed_booking_id") REFERENCES "appointment_bookings"("id") ON DELETE SET NULL;
ALTER TABLE "appointment_reminder_suppressions" ADD CONSTRAINT "appointment_reminder_suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION enforce_appointment_group_capacity()
RETURNS trigger AS $$
DECLARE
  seat_limit INTEGER;
  used_seats INTEGER;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;

  SELECT "max_attendees" INTO seat_limit
  FROM "appointment_services"
  WHERE "id" = NEW."service_id";

  IF seat_limit <= 1 THEN
    NEW."is_group_booking" := false;
    RETURN NEW;
  END IF;

  NEW."is_group_booking" := true;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."organization_id" || ':' || NEW."staff_id"::text || ':' || NEW."start_at"::text,
    0
  ));

  IF EXISTS (
    SELECT 1 FROM "appointment_bookings" existing
    WHERE existing."organization_id" = NEW."organization_id"
      AND existing."staff_id" = NEW."staff_id"
      AND existing."id" <> NEW."id"
      AND existing."status" IN ('pending', 'confirmed')
      AND existing."start_at" < NEW."end_at"
      AND existing."end_at" > NEW."start_at"
      AND (existing."service_id" <> NEW."service_id" OR existing."start_at" <> NEW."start_at" OR existing."end_at" <> NEW."end_at")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'group session overlaps another appointment', CONSTRAINT = 'appointment_bookings_group_session_overlap';
  END IF;

  SELECT COALESCE(SUM(existing."party_size"), 0) INTO used_seats
  FROM "appointment_bookings" existing
  WHERE existing."organization_id" = NEW."organization_id"
    AND existing."service_id" = NEW."service_id"
    AND existing."staff_id" = NEW."staff_id"
    AND existing."start_at" = NEW."start_at"
    AND existing."end_at" = NEW."end_at"
    AND existing."id" <> NEW."id"
    AND existing."status" IN ('pending', 'confirmed');

  IF used_seats + NEW."party_size" > seat_limit THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'appointment group capacity exceeded', CONSTRAINT = 'appointment_bookings_group_capacity';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "appointment_bookings_group_capacity_guard"
BEFORE INSERT OR UPDATE OF "status", "service_id", "staff_id", "start_at", "end_at", "party_size", "is_group_booking"
ON "appointment_bookings"
FOR EACH ROW EXECUTE FUNCTION enforce_appointment_group_capacity();
