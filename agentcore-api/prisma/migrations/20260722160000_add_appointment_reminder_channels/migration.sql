ALTER TABLE "appointment_booking_policies"
ADD COLUMN "reminder_channels" TEXT[] NOT NULL
DEFAULT ARRAY['email', 'sms', 'whatsapp']::TEXT[];
