# AgentCore Tesseract OCR

Stateless page OCR service for the primary, low-cost stage of the AgentCore
hybrid PDF pipeline. AgentCore renders only low-text PDF pages and sends each
page to `POST /v1/ocr` as PNG multipart data.

Build and run:

```bash
docker build -t agentcore-ocr-tesseract services/ocr-tesseract
docker run --rm -p 8080:8080 \
  -e OCR_API_KEY=replace-me \
  -e OCR_LANGUAGES=eng \
  agentcore-ocr-tesseract
```

In AgentCore, add this service from **Knowledge → Processing → OCR providers**:

- service: Local Tesseract
- endpoint: `http://ocr-tesseract:8080/v1/ocr`
- API key: the value of `OCR_API_KEY`
- settings language: `eng`

The deployment must separately allow the adapter host with
`KNOWLEDGE_OCR_ALLOWED_HOSTS=ocr-tesseract:8080` and enable private-network
access when the service is reached over an internal container network.

Use one Uvicorn worker per container and scale containers horizontally. CPU and
memory limits should be enforced by the container platform. Install additional
`tesseract-ocr-<language>` packages in the image before adding those languages
to `OCR_LANGUAGES`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCR_API_KEY` | empty | Optional bearer token shared with AgentCore. Required in production. |
| `OCR_LANGUAGES` | `eng` | Tesseract language expression, such as `eng+hin`. |
| `OCR_TIMEOUT_SECONDS` | `45` | Hard processing timeout for one page. |
| `OCR_MAX_IMAGE_BYTES` | `15728640` | Maximum rendered PNG request size. |
| `OCR_MAX_IMAGE_PIXELS` | `40000000` | Decompression-bomb and memory guard. |
