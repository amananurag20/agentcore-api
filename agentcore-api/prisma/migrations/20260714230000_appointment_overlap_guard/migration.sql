CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_active_staff_no_overlap"
EXCLUDE USING gist (
  "organization_id" WITH =,
  "staff_id" WITH =,
  tstzrange("start_at", "end_at", '[)') WITH &&
)
WHERE ("status" IN ('pending', 'confirmed'));
