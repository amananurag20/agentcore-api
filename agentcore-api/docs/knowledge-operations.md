# Knowledge Operations Runbook

## Production requirements

- Set `NODE_ENV=production` and `ALLOW_LOCAL_EMBEDDINGS=false`.
- Configure an active organization AI provider with an embedding model matching `DEFAULT_EMBEDDING_DIMENSIONS`.
- Run the API and `npm run start:worker` as separately monitored processes.
- Configure Redis persistence and a unique `QUEUE_PREFIX` per environment.
- Set `MALWARE_SCAN_REQUIRED=true` and configure `CLAMAV_HOST` and `CLAMAV_PORT`.
- Configure a primary page OCR endpoint for scanned PDFs. In production, use
  `KNOWLEDGE_OCR_MODE=fallback` so selectable PDF text is extracted without OCR.
- Set `KNOWLEDGE_OCR_ALLOWED_HOSTS` to the exact OCR adapter hostnames or
  `host:port` values reachable by the API. Production provider creation and
  invocation fail closed when this allowlist is empty or does not match.
- Optionally configure a managed fallback endpoint. It is called only when the
  primary OCR result is empty or below `KNOWLEDGE_OCR_MIN_CONFIDENCE`.
- Configure `KNOWLEDGE_ALERT_WEBHOOK_URL` for ingestion failures.
- Enable S3 bucket versioning, default encryption, lifecycle policies, and access logging.

## Hybrid PDF and OCR pipeline

### Workspace configuration

Super admins configure their own isolated **Platform Test Workspace** by
default. They configure a tenant only after explicitly entering that
organization. Organization admins can configure only their own organization.
Provider records, credentials, extraction thresholds, OCR cache entries, and
embedding selection are all organization-scoped.

In the console, open **Knowledge → Processing** to:

- choose native-only, hybrid fallback, or OCR-all-pages processing;
- register multiple local or managed OCR adapter endpoints;
- choose a primary OCR provider and a distinct low-confidence fallback;
- select the active embedding provider for this workspace;
- tune confidence, native-text quality, concurrency, retry, render, page, and
  extracted-character limits.

Credentials are AES-GCM encrypted at rest and are write-only in API responses.
Changing the selected embedding provider schedules ready sources for
re-indexing. A selected OCR or embedding provider cannot be deactivated or
deleted until the workspace policy selects another provider.

The environment values below are deployment defaults for workspaces that have
not saved a database policy. They also keep local/bootstrap deployments usable
before the first provider is registered in the console.

PDF ingestion is page-aware:

1. `pdf-parse` extracts selectable text from every page.
2. Pages meeting the configured character and alphanumeric-ratio thresholds
   bypass OCR entirely.
3. Remaining pages are rendered to PNG in bounded batches and sent to the
   primary OCR endpoint.
4. A low-confidence or empty primary result is sent to the optional fallback
   endpoint.
5. OCR output is cached by organization, rendered-page hash, and OCR pipeline
   signature. Re-ingestion and job retries therefore do not pay for the same OCR
   work again.
6. Each extracted PDF page becomes a separate knowledge document. Chunks and
   citations retain page number and extraction metadata.

Both OCR endpoints use the same provider-neutral HTTP contract. The endpoint
receives multipart form data containing:

- `file`: one rendered PDF page as `image/png`.
- `pageNumber`: the one-based source page number.
- `documentName`: the original filename when available.
- `settings`: JSON containing the selected provider's bounded adapter settings.

It returns:

```json
{
  "text": "Recognized page text",
  "confidence": 0.94,
  "provider": "local-tesseract",
  "model": "tesseract-5",
  "metadata": { "language": "eng" }
}
```

`confidence` may be either `0..1` or `0..100`. The API normalizes it to `0..1`.
The primary endpoint can be an OCRmyPDF/Tesseract service. The fallback endpoint
can be a small gateway around AWS Textract, Google Document AI, Azure Document
Intelligence, or another managed provider. Keeping this contract outside the
worker allows provider credentials, SDKs, autoscaling, and vendor-specific
polling to remain isolated from AgentCore.

A deployable stateless primary provider is included in
`services/ocr-tesseract`. Run one worker per container and scale replicas based
on CPU and request backlog. Keep the endpoint private and set `OCR_API_KEY` in
production.

Relevant configuration:

| Setting | Purpose |
| --- | --- |
| `KNOWLEDGE_OCR_MODE` | `disabled`, `fallback` (recommended), or `always`. |
| `KNOWLEDGE_OCR_PRIMARY_*` | Local/default OCR provider name, endpoint, and optional bearer key. |
| `KNOWLEDGE_OCR_FALLBACK_*` | Optional paid/managed fallback provider. |
| `KNOWLEDGE_OCR_ALLOWED_HOSTS` | Comma-separated SSRF allowlist for OCR adapter hosts. |
| `KNOWLEDGE_OCR_MIN_CONFIDENCE` | Primary confidence below which fallback is used. |
| `KNOWLEDGE_OCR_PAGE_CONCURRENCY` | Maximum OCR requests in flight per ingestion job. |
| `KNOWLEDGE_OCR_RENDER_WIDTH` | Rendered page width; higher values improve OCR but use more CPU/network. |
| `KNOWLEDGE_PDF_MAX_PAGES` | Hard page-count resource limit. |
| `KNOWLEDGE_OCR_CACHE_RETENTION_DAYS` | Removes cache entries not reused within the retention window. |

`KNOWLEDGE_OCR_ENDPOINT` and `KNOWLEDGE_OCR_API_KEY` remain supported as legacy
aliases for the primary endpoint.

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

Alert on failed ingestion jobs, queue backlog, jobs active beyond the ingestion timeout, stale website sources, OCR or ClamAV unavailability, embedding-provider errors, low OCR confidence, and a rise in paid fallback usage. The observability summary exposes knowledge source and queue counts.

## Retention

Source versions are retained by both count and age. Configure `KNOWLEDGE_SOURCE_VERSION_RETENTION` and `KNOWLEDGE_SOURCE_VERSION_RETENTION_DAYS`; the newest version is always retained. Database and object-storage lifecycle policies must be at least as long as this application retention window.

## Release check

Run migrations before deploying workers, then deploy API and workers from the same build. Confirm ClamAV, OCR, Redis, storage, and the embedding provider before enabling uploads. Roll back application processes first; additive migrations can remain during rollback.
