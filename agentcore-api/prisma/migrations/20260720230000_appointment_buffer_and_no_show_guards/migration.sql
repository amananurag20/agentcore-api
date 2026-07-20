ALTER TABLE "appointment_bookings"
  ADD COLUMN "blocked_start_at" TIMESTAMP(3),
  ADD COLUMN "blocked_end_at" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION set_appointment_blocked_range()
RETURNS trigger AS $$
DECLARE
  buffer_before INTEGER;
  buffer_after INTEGER;
BEGIN
  SELECT "buffer_before_minutes", "buffer_after_minutes"
    INTO buffer_before, buffer_after
  FROM "appointment_services"
  WHERE "id" = NEW."service_id";

  IF buffer_before IS NULL OR buffer_after IS NULL THEN
    RAISE EXCEPTION 'appointment service not found while calculating buffer range';
  END IF;

  NEW."blocked_start_at" := NEW."start_at" - make_interval(mins => buffer_before);
  NEW."blocked_end_at" := NEW."end_at" + make_interval(mins => buffer_after);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE "appointment_bookings" booking
SET
  "blocked_start_at" = booking."start_at" - make_interval(mins => service."buffer_before_minutes"),
  "blocked_end_at" = booking."end_at" + make_interval(mins => service."buffer_after_minutes")
FROM "appointment_services" service
WHERE service."id" = booking."service_id";

ALTER TABLE "appointment_bookings"
  ALTER COLUMN "blocked_start_at" SET NOT NULL,
  ALTER COLUMN "blocked_end_at" SET NOT NULL;

CREATE TRIGGER "appointment_bookings_00_buffer_range"
BEFORE INSERT OR UPDATE OF "service_id", "start_at", "end_at"
ON "appointment_bookings"
FOR EACH ROW EXECUTE FUNCTION set_appointment_blocked_range();

CREATE OR REPLACE FUNCTION lock_appointment_staff_schedule()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('pending', 'confirmed') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW."organization_id" || ':' || NEW."staff_id"::text,
      0
    ));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "appointment_bookings_01_staff_schedule_lock"
BEFORE INSERT OR UPDATE OF "status", "service_id", "staff_id", "start_at", "end_at"
ON "appointment_bookings"
FOR EACH ROW EXECUTE FUNCTION lock_appointment_staff_schedule();

CREATE OR REPLACE FUNCTION enforce_appointment_buffered_overlap()
RETURNS trigger AS $$
DECLARE
  seat_limit INTEGER;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;

  SELECT "max_attendees" INTO seat_limit
  FROM "appointment_services"
  WHERE "id" = NEW."service_id";

  IF EXISTS (
    SELECT 1
    FROM "appointment_bookings" existing
    WHERE existing."organization_id" = NEW."organization_id"
      AND existing."staff_id" = NEW."staff_id"
      AND existing."id" <> NEW."id"
      AND existing."status" IN ('pending', 'confirmed')
      AND existing."blocked_start_at" < NEW."blocked_end_at"
      AND existing."blocked_end_at" > NEW."blocked_start_at"
      AND NOT (
        seat_limit > 1
        AND existing."service_id" = NEW."service_id"
        AND existing."start_at" = NEW."start_at"
        AND existing."end_at" = NEW."end_at"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'appointment buffer overlaps another appointment', CONSTRAINT = 'appointment_bookings_buffered_overlap';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "appointment_bookings_02_buffered_overlap"
BEFORE INSERT OR UPDATE OF "status", "service_id", "staff_id", "start_at", "end_at"
ON "appointment_bookings"
FOR EACH ROW EXECUTE FUNCTION enforce_appointment_buffered_overlap();

ALTER TABLE "appointment_bookings"
  DROP CONSTRAINT IF EXISTS "appointment_bookings_active_staff_no_overlap";

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_active_staff_no_overlap"
EXCLUDE USING gist (
  "organization_id" WITH =,
  "staff_id" WITH =,
  tsrange("blocked_start_at", "blocked_end_at", '[)') WITH &&
)
WHERE ("status" IN ('pending', 'confirmed') AND NOT "is_group_booking");

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
    NEW."organization_id" || ':' || NEW."staff_id"::text,
    0
  ));

  IF EXISTS (
    SELECT 1 FROM "appointment_bookings" existing
    WHERE existing."organization_id" = NEW."organization_id"
      AND existing."staff_id" = NEW."staff_id"
      AND existing."id" <> NEW."id"
      AND existing."status" IN ('pending', 'confirmed')
      AND existing."blocked_start_at" < NEW."blocked_end_at"
      AND existing."blocked_end_at" > NEW."blocked_start_at"
      AND (
        existing."service_id" <> NEW."service_id" OR
        existing."start_at" <> NEW."start_at" OR
        existing."end_at" <> NEW."end_at"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'group session buffer overlaps another appointment', CONSTRAINT = 'appointment_bookings_group_session_overlap';
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

CREATE OR REPLACE FUNCTION refresh_appointment_service_buffer_ranges()
RETURNS trigger AS $$
BEGIN
  IF NEW."buffer_before_minutes" IS DISTINCT FROM OLD."buffer_before_minutes"
     OR NEW."buffer_after_minutes" IS DISTINCT FROM OLD."buffer_after_minutes" THEN
    UPDATE "appointment_bookings"
    SET
      "start_at" = "start_at",
      "end_at" = "end_at"
    WHERE "service_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "appointment_services_buffer_range_refresh"
AFTER UPDATE OF "buffer_before_minutes", "buffer_after_minutes"
ON "appointment_services"
FOR EACH ROW EXECUTE FUNCTION refresh_appointment_service_buffer_ranges();

CREATE INDEX "appointment_bookings_no_show_scan_idx"
ON "appointment_bookings" ("status", "end_at")
WHERE "status" IN ('pending', 'confirmed') AND "checked_in_at" IS NULL;
