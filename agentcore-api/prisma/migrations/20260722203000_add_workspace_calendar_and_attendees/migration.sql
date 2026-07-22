CREATE TYPE "AppointmentCalendarConnectionScope" AS ENUM ('organization', 'staff');

ALTER TABLE "appointment_services"
ADD COLUMN "default_attendee_staff_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "appointment_bookings"
ADD COLUMN "attendee_staff_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "attendee_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "appointment_calendar_connections"
ADD COLUMN "scope" "AppointmentCalendarConnectionScope" NOT NULL DEFAULT 'staff',
ALTER COLUMN "staff_id" DROP NOT NULL;

ALTER TABLE "appointment_calendar_connections"
DROP CONSTRAINT IF EXISTS "appointment_calendar_connections_staff_id_provider_calendar_id_key";

CREATE UNIQUE INDEX "appointment_calendar_connections_workspace_unique"
ON "appointment_calendar_connections" ("organization_id")
WHERE "scope" = 'organization';

CREATE UNIQUE INDEX "appointment_calendar_connections_staff_unique"
ON "appointment_calendar_connections" ("staff_id", "provider", "calendar_id")
WHERE "scope" = 'staff';

CREATE INDEX "appointment_calendar_connections_staff_id_status_idx"
ON "appointment_calendar_connections" ("staff_id", "status");
