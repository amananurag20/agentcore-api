ALTER TABLE "organizations"
ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

UPDATE "organizations"
SET "is_system" = true
WHERE "id" = 'org_demo';

UPDATE "organization_products"
SET "status" = 'enabled'
WHERE "organization_id" = 'org_demo';

CREATE INDEX "organizations_is_system_idx" ON "organizations"("is_system");
