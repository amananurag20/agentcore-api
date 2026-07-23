-- One workspace user can own at most one scheduling profile. PostgreSQL unique
-- indexes allow multiple NULL values, so legacy unlinked staff remain valid.
DROP INDEX IF EXISTS "appointment_staff_user_id_idx";

CREATE UNIQUE INDEX "appointment_staff_user_id_key"
  ON "appointment_staff"("user_id");
