# Knowledge Operations Runbook

## Production requirements

- Set `NODE_ENV=production` and `ALLOW_LOCAL_EMBEDDINGS=false`.
- Configure an active organization AI provider with an embedding model matching `DEFAULT_EMBEDDING_DIMENSIONS`.
- Run the API and `npm run start:worker` as separately monitored processes.
- Configure Redis persistence and a unique `QUEUE_PREFIX` per environment.
- Set `MALWARE_SCAN_REQUIRED=true` and configure `CLAMAV_HOST` and `CLAMAV_PORT`.
- Configure `KNOWLEDGE_OCR_ENDPOINT` for scanned PDFs.
- Configure `KNOWLEDGE_ALERT_WEBHOOK_URL` for ingestion failures.
- Enable S3 bucket versioning, default encryption, lifecycle policies, and access logging.

The OCR endpoint receives multipart form data with a PDF in the `file` field and must return JSON shaped as `{ "text": "...", "pageCount": 3 }`.

## Backup

1. Take automated PostgreSQL backups with point-in-time recovery enabled. Include the `vector` extension, knowledge tables, source versions, users, roles, and audit logs.
2. Replicate the knowledge object bucket to a separate account or region. Retain object versions longer than the database backup window.
3. Encrypt backups with a separately managed key and restrict restore permissions to the operations role.
4. Record backup completion, size, checksum, and recovery point in monitoring.

## Restore drill

Run at least quarterly in an isolated environment:

1. Restore PostgreSQL to a new database and verify migration status.
2. Restore or attach the matching object-storage snapshot.
3. Start one API and one worker with outbound customer channels disabled.
4. Verify tenant isolation using two organizations and restricted sources.
5. Re-ingest a file and website source, then compare retrieval results with the source content.
6. Record recovery point objective, recovery time objective, failures, and corrective actions.

## Alerts

Alert on failed ingestion jobs, queue backlog, jobs active beyond the ingestion timeout, stale website sources, OCR or ClamAV unavailability, embedding-provider errors, and a rise in fallback responses. The observability summary exposes knowledge source and queue counts.

## Retention

Source versions are retained by both count and age. Configure `KNOWLEDGE_SOURCE_VERSION_RETENTION` and `KNOWLEDGE_SOURCE_VERSION_RETENTION_DAYS`; the newest version is always retained. Database and object-storage lifecycle policies must be at least as long as this application retention window.

## Release check

Run migrations before deploying workers, then deploy API and workers from the same build. Confirm ClamAV, OCR, Redis, storage, and the embedding provider before enabling uploads. Roll back application processes first; additive migrations can remain during rollback.
