ALTER TABLE "user_product_access"
ADD COLUMN "can_manage_knowledge" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "custom_roles" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "clearance_level" INTEGER NOT NULL DEFAULT 0,
  "is_template" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custom_role_product_access" (
  "id" TEXT NOT NULL,
  "custom_role_id" TEXT NOT NULL,
  "product_key" "ProductKey" NOT NULL,
  "can_use" BOOLEAN NOT NULL DEFAULT true,
  "can_configure" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_agents" BOOLEAN NOT NULL DEFAULT false,
  "can_manage_knowledge" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_role_product_access_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_custom_roles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "custom_role_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "assigned_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_custom_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_principals" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "product_key" "ProductKey" NOT NULL,
  "name" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "secret_hash" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_id" TEXT,
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_principals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_categories" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "is_system" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_folders" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "parent_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_folders_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "knowledge_sources" ADD COLUMN "folder_id" TEXT;

CREATE UNIQUE INDEX "custom_roles_organization_id_name_key"
ON "custom_roles"("organization_id", "name");
CREATE INDEX "custom_roles_organization_id_is_active_idx"
ON "custom_roles"("organization_id", "is_active");
CREATE UNIQUE INDEX "custom_role_product_access_custom_role_id_product_key_key"
ON "custom_role_product_access"("custom_role_id", "product_key");
CREATE INDEX "custom_role_product_access_product_key_idx"
ON "custom_role_product_access"("product_key");
CREATE UNIQUE INDEX "user_custom_roles_user_id_custom_role_id_key"
ON "user_custom_roles"("user_id", "custom_role_id");
CREATE INDEX "user_custom_roles_organization_id_custom_role_id_idx"
ON "user_custom_roles"("organization_id", "custom_role_id");
CREATE UNIQUE INDEX "service_principals_client_id_key"
ON "service_principals"("client_id");
CREATE INDEX "service_principals_organization_id_product_key_is_active_idx"
ON "service_principals"("organization_id", "product_key", "is_active");
CREATE UNIQUE INDEX "knowledge_categories_organization_id_slug_key" ON "knowledge_categories"("organization_id", "slug");
CREATE INDEX "knowledge_categories_organization_id_name_idx" ON "knowledge_categories"("organization_id", "name");
CREATE UNIQUE INDEX "knowledge_folders_organization_id_parent_id_name_key" ON "knowledge_folders"("organization_id", "parent_id", "name");
CREATE INDEX "knowledge_folders_organization_id_parent_id_idx" ON "knowledge_folders"("organization_id", "parent_id");
CREATE INDEX "knowledge_sources_folder_id_idx" ON "knowledge_sources"("folder_id");

ALTER TABLE "custom_roles"
ADD CONSTRAINT "custom_roles_clearance_level_check"
CHECK ("clearance_level" BETWEEN 0 AND 4);
ALTER TABLE "custom_roles"
ADD CONSTRAINT "custom_roles_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_role_product_access"
ADD CONSTRAINT "custom_role_product_access_custom_role_id_fkey"
FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_custom_roles"
ADD CONSTRAINT "user_custom_roles_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_custom_roles"
ADD CONSTRAINT "user_custom_roles_custom_role_id_fkey"
FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_custom_roles"
ADD CONSTRAINT "user_custom_roles_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_principals"
ADD CONSTRAINT "service_principals_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_categories" ADD CONSTRAINT "knowledge_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "knowledge_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
