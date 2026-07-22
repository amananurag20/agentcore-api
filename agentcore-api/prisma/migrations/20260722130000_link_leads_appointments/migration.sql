ALTER TABLE "appointment_bookings"
ADD COLUMN "lead_id" TEXT;

CREATE INDEX "appointment_bookings_lead_id_start_at_idx"
ON "appointment_bookings"("lead_id", "start_at");

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_lead_id_fkey"
FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
