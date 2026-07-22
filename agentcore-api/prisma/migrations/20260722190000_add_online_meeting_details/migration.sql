CREATE TYPE "AppointmentMeetingType" AS ENUM ('online', 'in_person', 'phone');

ALTER TABLE "appointment_services"
ADD COLUMN "meeting_type" "AppointmentMeetingType" NOT NULL DEFAULT 'online',
ADD COLUMN "location" TEXT;

ALTER TABLE "appointment_bookings"
ADD COLUMN "meeting_type" "AppointmentMeetingType" NOT NULL DEFAULT 'online',
ADD COLUMN "meeting_provider" "AppointmentCalendarProvider",
ADD COLUMN "meeting_url" TEXT,
ADD COLUMN "location" TEXT;
