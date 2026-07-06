-- CreateEnum
CREATE TYPE "ProductKey" AS ENUM (
  'customer_chat',
  'appointment_booking',
  'whatsapp_assistant',
  'voice_receptionist'
);

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "OrganizationProductStatus" AS ENUM ('enabled', 'disabled');

-- CreateTable
CREATE TABLE "products" (
  "id" TEXT NOT NULL,
  "key" "ProductKey" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" "ProductStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_products" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "status" "OrganizationProductStatus" NOT NULL DEFAULT 'disabled',
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_key_key" ON "products"("key");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_products_organization_id_product_id_key"
  ON "organization_products"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "organization_products_organization_id_status_idx"
  ON "organization_products"("organization_id", "status");

-- CreateIndex
CREATE INDEX "organization_products_product_id_idx"
  ON "organization_products"("product_id");

-- AddForeignKey
ALTER TABLE "organization_products"
  ADD CONSTRAINT "organization_products_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_products"
  ADD CONSTRAINT "organization_products_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
