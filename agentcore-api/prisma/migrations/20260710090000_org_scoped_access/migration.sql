ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'product_admin';

ALTER TABLE "organizations"
ADD COLUMN "contact_email" TEXT,
ADD COLUMN "contact_phone" TEXT;

ALTER TABLE "users"
ADD COLUMN "clearance_level" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "user_product_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "product_key" "ProductKey" NOT NULL,
    "can_use" BOOLEAN NOT NULL DEFAULT true,
    "can_configure" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_agents" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_product_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_product_access_user_id_product_key_key"
ON "user_product_access"("user_id", "product_key");

CREATE INDEX "user_product_access_organization_id_product_key_idx"
ON "user_product_access"("organization_id", "product_key");

ALTER TABLE "user_product_access"
ADD CONSTRAINT "user_product_access_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_product_access"
ADD CONSTRAINT "user_product_access_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
