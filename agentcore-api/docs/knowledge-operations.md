# Knowledge Operations Runbook

## Production requirements

- Set `NODE_ENV=production` and `ALLOW_LOCAL_EMBEDDINGS=false`.
- Configure an active organization AI provider with a 1536-dimension embedding model matching the fixed knowledge vector index.
- Run the API and `npm run start:worker` as separately monitored processes.
- Configure Redis persistence and a unique `QUEUE_PREFIX` per environment.
- Configure `CLAMAV_HOST`; malware scanning is fail-closed by default.
- Configure the primary OCR provider and hybrid fallback mode in
  **Knowledge → Processing** for each workspace.
- Set `KNOWLEDGE_OCR_ALLOWED_HOSTS` to the exact OCR adapter hostnames or
  `host:port` values reachable by the API. Production provider creation and
  invocation fail closed when this allowlist is empty or does not match.
- Optionally configure a managed fallback provider in the same workspace. It is
  called only when the primary OCR result is empty or below the workspace's
  configured minimum confidence.
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

Workspaces without a saved policy receive versioned application defaults, but
no OCR provider credentials. OCR provider records and credentials come only
from Postgres after they are configured in the console.

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

| Setting | Owner |
| --- | --- |
| OCR mode, primary/fallback provider, confidence, concurrency, retry and document limits | Workspace policy in Postgres. |
| OCR provider endpoint, API key and provider-specific settings | Encrypted workspace provider record in Postgres. |
| `KNOWLEDGE_OCR_ALLOWED_HOSTS` | Deployment-wide SSRF allowlist in the environment. |
| `KNOWLEDGE_OCR_ALLOW_PRIVATE_NETWORKS` | Deployment-wide private-network policy in the environment. |
| Cache retention and fixed resource defaults | Versioned application constants. |

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
# Large-document scaling

Large knowledge files use two paths:

- Files up to 20 MB may use the authenticated API upload endpoint.
- The console automatically uses a 15-minute presigned object-storage URL above 20 MB, verifies the stored object, creates the source, and queues malware scanning and ingestion asynchronously.

Every queued attempt is persisted in `knowledge_ingestion_runs`. The run stores its BullMQ job ID, stage, percentage, item counts, attempt count, cancellation request, terminal error, and timestamps. A source cannot have two uncancelled active runs. Workers check cancellation between extraction and embedding batches, and exhausted jobs are marked `dead_letter` for operations review.

Upload, batching, worker-concurrency and document-limit defaults are versioned
in application code. Workspace-adjustable extraction limits are saved through
the Processing screen rather than copied into deployment environment files.

Run API and worker deployments independently. Scale workers from BullMQ waiting count and oldest-job age, not API traffic. Start with 2 ingestion jobs per worker pod and at least 2 GiB memory per pod; tune from representative PDFs because PDF render memory depends on image density and page dimensions. Keep OCR page concurrency and embedding concurrency below provider account limits.

The object-storage bucket must allow browser `PUT` from console origins. A minimal S3 CORS rule is:

```json
[
  {
    "AllowedOrigins": ["https://console.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-*"],
    "ExposeHeaders": ["etag", "x-amz-checksum-sha256"],
    "MaxAgeSeconds": 3600
  }
]
```

Alert on queue waiting age, dead-letter count, ingestion failure rate, OCR fallback rate, provider throttling, and p95 completion time. Validate capacity before increasing tenant limits with 100, 1,000, and 5,000-page fixtures containing both native and scanned pages.
