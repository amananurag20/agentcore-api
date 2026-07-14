ALTER TYPE "AppointmentReminderStatus" ADD VALUE IF NOT EXISTS 'dead_letter';
ALTER TYPE "AppointmentCalendarEventStatus" ADD VALUE IF NOT EXISTS 'dead_letter';
