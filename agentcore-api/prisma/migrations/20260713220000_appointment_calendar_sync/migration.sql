CREATE TYPE "AppointmentCalendarProvider" AS ENUM ('google', 'microsoft');
CREATE TYPE "AppointmentCalendarConnectionStatus" AS ENUM ('pending', 'active', 'error', 'disconnected');
CREATE TYPE "AppointmentCalendarEventStatus" AS ENUM ('pending', 'syncing', 'synced', 'failed', 'deleted');

CREATE TABLE "appointment_calendar_connections" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "provider" "AppointmentCalendarProvider" NOT NULL,
  "status" "AppointmentCalendarConnectionStatus" NOT NULL DEFAULT 'pending',
  "account_email" TEXT,
  "calendar_id" TEXT NOT NULL DEFAULT 'primary',
  "calendar_name" TEXT,
  "access_token_encrypted" TEXT,
  "refresh_token_encrypted" TEXT,
  "token_expires_at" TIMESTAMP(3),
  "oauth_state_hash" TEXT,
  "oauth_state_expires_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3),
  "last_error" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_calendar_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_calendar_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "external_event_id" TEXT,
  "external_etag" TEXT,
  "operation" TEXT NOT NULL DEFAULT 'upsert',
  "status" "AppointmentCalendarEventStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "last_synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_calendar_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointment_calendar_connections_staff_id_provider_calendar_id_key" ON "appointment_calendar_connections"("staff_id", "provider", "calendar_id");
CREATE INDEX "appointment_calendar_connections_organization_id_status_idx" ON "appointment_calendar_connections"("organization_id", "status");
CREATE INDEX "appointment_calendar_connections_oauth_state_hash_idx" ON "appointment_calendar_connections"("oauth_state_hash");
CREATE UNIQUE INDEX "appointment_calendar_events_booking_id_connection_id_key" ON "appointment_calendar_events"("booking_id", "connection_id");
CREATE INDEX "appointment_calendar_events_organization_id_status_idx" ON "appointment_calendar_events"("organization_id", "status");
CREATE INDEX "appointment_calendar_events_connection_id_status_idx" ON "appointment_calendar_events"("connection_id", "status");

ALTER TABLE "appointment_calendar_connections" ADD CONSTRAINT "appointment_calendar_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_calendar_connections" ADD CONSTRAINT "appointment_calendar_connections_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "appointment_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "appointment_calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
