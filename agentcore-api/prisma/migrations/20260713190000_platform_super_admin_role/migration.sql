UPDATE "users"
SET "roles" = ARRAY['super_admin']::"UserRole"[]
WHERE "org_id" IN (
  SELECT "id"
  FROM "organizations"
  WHERE "is_system" = true
)
AND 'super_admin'::"UserRole" = ANY("roles");
