ALTER TABLE "whatsapp_templates"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "submitted_at" TIMESTAMP(3);
