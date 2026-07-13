INSERT INTO "organization_products" (
  "id",
  "organization_id",
  "product_id",
  "status",
  "config",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text,
  organization."id",
  product."id",
  'disabled'::"OrganizationProductStatus",
  '{}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "organizations" AS organization
CROSS JOIN "products" AS product
WHERE product."status" = 'active'::"ProductStatus"
ON CONFLICT ("organization_id", "product_id") DO NOTHING;
