CREATE TYPE "AppointmentResourceStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "appointment_resources" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'generic',
  "capacity" INTEGER NOT NULL DEFAULT 1,
  "status" "AppointmentResourceStatus" NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_resources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_resources_capacity_check" CHECK ("capacity" > 0)
);

CREATE TABLE "appointment_service_resources" (
  "service_id" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_service_resources_pkey" PRIMARY KEY ("service_id", "resource_id"),
  CONSTRAINT "appointment_service_resources_quantity_check" CHECK ("quantity" > 0)
);

CREATE TABLE "appointment_staff_resources" (
  "staff_id" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_staff_resources_pkey" PRIMARY KEY ("staff_id", "resource_id")
);

CREATE TABLE "appointment_resource_time_off" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appointment_resource_time_off_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_resource_time_off_range_check" CHECK ("start_at" < "end_at")
);

CREATE TABLE "appointment_booking_resources" (
  "booking_id" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_booking_resources_pkey" PRIMARY KEY ("booking_id", "resource_id"),
  CONSTRAINT "appointment_booking_resources_quantity_check" CHECK ("quantity" > 0)
);

CREATE INDEX "appointment_resources_organization_id_status_idx" ON "appointment_resources"("organization_id", "status");
CREATE INDEX "appointment_service_resources_resource_id_idx" ON "appointment_service_resources"("resource_id");
CREATE INDEX "appointment_staff_resources_resource_id_idx" ON "appointment_staff_resources"("resource_id");
CREATE INDEX "appointment_resource_time_off_organization_id_idx" ON "appointment_resource_time_off"("organization_id");
CREATE INDEX "appointment_resource_time_off_resource_id_start_at_end_at_idx" ON "appointment_resource_time_off"("resource_id", "start_at", "end_at");
CREATE INDEX "appointment_booking_resources_resource_id_idx" ON "appointment_booking_resources"("resource_id");

ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_service_resources" ADD CONSTRAINT "appointment_service_resources_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "appointment_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_service_resources" ADD CONSTRAINT "appointment_service_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "appointment_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_staff_resources" ADD CONSTRAINT "appointment_staff_resources_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "appointment_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_staff_resources" ADD CONSTRAINT "appointment_staff_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "appointment_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_resource_time_off" ADD CONSTRAINT "appointment_resource_time_off_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_resource_time_off" ADD CONSTRAINT "appointment_resource_time_off_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "appointment_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_booking_resources" ADD CONSTRAINT "appointment_booking_resources_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "appointment_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_booking_resources" ADD CONSTRAINT "appointment_booking_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "appointment_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
