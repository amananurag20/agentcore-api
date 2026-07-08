CREATE TYPE "AppointmentServiceStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "AppointmentStaffStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "AppointmentBookingStatus" AS ENUM (
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show'
);

CREATE TABLE "appointment_services" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "duration_minutes" INTEGER NOT NULL,
  "buffer_before_minutes" INTEGER NOT NULL DEFAULT 0,
  "buffer_after_minutes" INTEGER NOT NULL DEFAULT 0,
  "price_cents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "AppointmentServiceStatus" NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_staff" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "status" "AppointmentStaffStatus" NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_staff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_staff_services" (
  "id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "appointment_staff_services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_staff_availability" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "day_of_week" INTEGER NOT NULL,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_staff_availability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_staff_time_off" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_staff_time_off_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_bookings" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "staff_id" TEXT NOT NULL,
  "status" "AppointmentBookingStatus" NOT NULL DEFAULT 'confirmed',
  "customer_name" TEXT NOT NULL,
  "customer_email" TEXT,
  "customer_phone" TEXT,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "notes" TEXT,
  "cancellation_reason" TEXT,
  "rescheduled_from_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_bookings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "appointment_services_organization_id_status_idx"
ON "appointment_services"("organization_id", "status");

CREATE INDEX "appointment_staff_organization_id_status_idx"
ON "appointment_staff"("organization_id", "status");

CREATE INDEX "appointment_staff_user_id_idx"
ON "appointment_staff"("user_id");

CREATE UNIQUE INDEX "appointment_staff_services_staff_id_service_id_key"
ON "appointment_staff_services"("staff_id", "service_id");

CREATE INDEX "appointment_staff_services_service_id_idx"
ON "appointment_staff_services"("service_id");

CREATE INDEX "appointment_staff_availability_organization_id_idx"
ON "appointment_staff_availability"("organization_id");

CREATE INDEX "appointment_staff_availability_staff_id_day_of_week_is_active_idx"
ON "appointment_staff_availability"("staff_id", "day_of_week", "is_active");

CREATE INDEX "appointment_staff_time_off_organization_id_idx"
ON "appointment_staff_time_off"("organization_id");

CREATE INDEX "appointment_staff_time_off_staff_id_start_at_end_at_idx"
ON "appointment_staff_time_off"("staff_id", "start_at", "end_at");

CREATE INDEX "appointment_bookings_organization_id_status_idx"
ON "appointment_bookings"("organization_id", "status");

CREATE INDEX "appointment_bookings_service_id_idx"
ON "appointment_bookings"("service_id");

CREATE INDEX "appointment_bookings_staff_id_start_at_end_at_idx"
ON "appointment_bookings"("staff_id", "start_at", "end_at");

CREATE INDEX "appointment_bookings_customer_email_idx"
ON "appointment_bookings"("customer_email");

ALTER TABLE "appointment_services"
ADD CONSTRAINT "appointment_services_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff"
ADD CONSTRAINT "appointment_staff_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff"
ADD CONSTRAINT "appointment_staff_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_services"
ADD CONSTRAINT "appointment_staff_services_staff_id_fkey"
FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_services"
ADD CONSTRAINT "appointment_staff_services_service_id_fkey"
FOREIGN KEY ("service_id") REFERENCES "appointment_services"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_availability"
ADD CONSTRAINT "appointment_staff_availability_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_availability"
ADD CONSTRAINT "appointment_staff_availability_staff_id_fkey"
FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_time_off"
ADD CONSTRAINT "appointment_staff_time_off_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_staff_time_off"
ADD CONSTRAINT "appointment_staff_time_off_staff_id_fkey"
FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_service_id_fkey"
FOREIGN KEY ("service_id") REFERENCES "appointment_services"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointment_bookings"
ADD CONSTRAINT "appointment_bookings_staff_id_fkey"
FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
