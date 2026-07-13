UPDATE "organizations"
SET
  "name" = 'Platform Test Workspace',
  "slug" = 'platform-test-workspace',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'org_demo'
  AND "name" = 'Demo Organization';
