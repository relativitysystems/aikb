# Relativity AI Knowledge Base — Backend

Multi-client document ingestion, indexing, and RAG Q&A backend.  
Built with Node.js + Express, Inngest, Supabase (PostgreSQL + pgvector + Storage), and OpenAI.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values below.

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default `3000`) | HTTP server port |
| `NODE_ENV` | No (default `development`) | `development` or `production` |
| `AIKB_SUPABASE_URL` | **Yes** | Supabase project URL for the AIKB project |
| `AIKB_SUPABASE_SERVICE_KEY` | **Yes** | Service role key for the AIKB project (never expose to frontend) |
| `GLOBAL_SUPABASE_URL` | **Yes** | Supabase project URL for the Relativity_Global project (master clients table) |
| `GLOBAL_SUPABASE_SERVICE_KEY` | **Yes** | Service role key for Relativity_Global |
| `OPENAI_API_KEY` | **Yes** | OpenAI API key for embeddings and chat completions |
| `OPENAI_EMBEDDING_MODEL` | No (default `text-embedding-3-small`) | Embedding model name |
| `OPENAI_CHAT_MODEL` | No (default `gpt-4.1`) | Full RAG answers / general chat completions |
| `OPENAI_LIGHTWEIGHT_MODEL` | No (default `gpt-4o-mini`) | Intent classifier + retrieval query rewriter |
| `INNGEST_EVENT_KEY` | Yes in production | Inngest event key |
| `INNGEST_SIGNING_KEY` | Yes in production | Inngest signing key |
| `INNGEST_DEFAULT_RETRIES` | No (default `3`) | Retry count applied to every Inngest function |
| `AIKB_STORAGE_BUCKET` | No (default `aikb-documents`) | Supabase Storage bucket name where portal documents are uploaded |
| `MAX_UPLOAD_BYTES` | No (default `10485760`, 10 MB) | Max file size accepted for ingestion |
| `API_KEY` | Yes in production | Shared secret for `x-api-key` header on all `/api/knowledge/*` routes |
| `KNOWLEDGE_API_RATE_LIMIT_WINDOW_MS` / `_MAX` | No (default 15 min / 2000) | Defense-in-depth rate limit across `/api/knowledge/*` |
| `RECENT_INGESTION_JOBS_LIMIT` | No (default `100`) | Window for client stats/health endpoints |
| `RECENT_ACTIVITY_LIMIT` | No (default `10`) | "Recent" slice in analytics/stats responses |
| `CHAT_CONTEXT_MESSAGE_LIMIT` | No (default `8`) | Prior messages fed to the intent classifier/query rewriter |
| `KNOWLEDGE_GAPS_LIST_LIMIT` | No (default `200`) | Row cap for the admin knowledge-gaps list |
| `SLACK_SIGNING_SECRET` | Yes in production | Verifies the retired `/api/slack/events` endpoint's webhook signature (see note below) |
| `SERVICE_REQUEST_SIGNING_SECRET` | **Yes** | HMAC envelope shared with Relativity, scoped to `/api/knowledge/ask` and `/api/integrations/slack/deliver` |
| `RELATIVITY_API_BASE_URL` | **Yes** | Relativity's base URL, called back for Slack delivery and the email sync tick |
| `RELATIVITY_DELIVER_TIMEOUT_MS` | No (default `8000`) | Timeout for the Slack-answer delivery callback to Relativity |
| `RELATIVITY_TICK_TIMEOUT_MS` | No (default `15000`) | Timeout for the email sync tick callback to Relativity |
| `EMAIL_SYNC_TICK_CRON_SCHEDULE` | No (default `*/20 * * * *`) | Cadence of the automatic email-sync scheduler |

> `POST /api/slack/events` is **retired** (Architecture Review Phase 4, Milestone 1 — see ADR-003 "Slack Events Live in Relativity" in the Architecture repo) — it answers Slack's `url_verification` challenge and returns `410 Gone` for every real event. Slack Events ingestion now lives entirely in Relativity. `SLACK_SIGNING_SECRET` is still required in production so this endpoint can verify (and reject) unsigned traffic before responding.
>
> Two additional service-to-service routes exist beyond the ones documented below: `POST /api/knowledge/ask` (the Slack Q&A pipeline's accept-and-enqueue leg, called by Relativity) and `POST /api/knowledge/chat/redact` (ADR-007 redaction callback). Both are signed with `SERVICE_REQUEST_SIGNING_SECRET`, not `x-api-key` alone.

---

## Database Migrations

Run migrations in order in the **AIKB Supabase project** SQL editor.

### Migration 001 — Initial schema

Run the contents of `migrations/001_knowledge_base_schema.sql`.

This creates:
- `knowledge_documents` table
- `knowledge_chunks` table (with pgvector `VECTOR(1536)` column)
- `knowledge_ingestion_jobs` table
- `match_knowledge_chunks` RPC function for cosine similarity search

### Migration 002 — Add storage_path column

Run the contents of `migrations/002_add_storage_path.sql`.

```sql
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS storage_path TEXT;
```

This adds a nullable column to store the Supabase Storage path for portal-uploaded documents.

---

## Supabase Storage Bucket Setup

For the `portal_upload` source provider, files are downloaded from Supabase Storage.

1. Open the **AIKB** Supabase project → Storage.
2. Create a bucket named `aikb-documents` (or whatever you set in `AIKB_STORAGE_BUCKET`).
3. Set the bucket to **private** (files are accessed using the service role key, never from the browser).
4. The portal uploads files to this bucket before calling the ingest API. The upload path convention is:  
   `uploads/<clientId>/<unique-filename>.<ext>`

---

## Running Locally

```bash
# Install dependencies
npm install

# Start the Inngest dev server (separate terminal)
npx inngest-cli@latest dev

# Start the API server
npm run dev
```

The API server listens on `http://localhost:3000`.  
The Inngest dashboard is at `http://localhost:8288`.

---

## API Reference

All routes require the `x-api-key` header in production. In development (`NODE_ENV=development`), the header is optional if `API_KEY` is not set.

### Ingest a document — portal upload

```bash
curl -X POST http://localhost:3000/api/knowledge/ingest \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "clientId": "00000000-0000-0000-0000-000000000001",
    "sourceFileId": "unique-stable-id-for-this-file",
    "fileName": "onboarding-guide.pdf",
    "mimeType": "application/pdf",
    "sourceProvider": "portal_upload",
    "storagePath": "uploads/00000000-0000-0000-0000-000000000001/onboarding-guide.pdf"
  }'
```

Response:
```json
{ "queued": true, "eventId": "01JABCDEF..." }
```

### Query the knowledge base

```bash
curl -X POST http://localhost:3000/api/knowledge/query \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "clientId": "00000000-0000-0000-0000-000000000001",
    "question": "What is the client onboarding process?"
  }'
```

Response:
```json
{
  "answer": "According to the onboarding guide...",
  "sources": [
    { "fileName": "onboarding-guide.pdf", "documentId": "uuid..." }
  ]
}
```

### List indexed documents

```bash
curl http://localhost:3000/api/knowledge/documents/00000000-0000-0000-0000-000000000001 \
  -H "x-api-key: $API_KEY"
```

### Delete a document (by source)

```bash
curl -X DELETE http://localhost:3000/api/knowledge/document/by-source \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "clientId": "00000000-0000-0000-0000-000000000001",
    "sourceFileId": "unique-stable-id-for-this-file",
    "sourceProvider": "portal_upload"
  }'
```

For portal_upload documents, this also removes the file from Supabase Storage (best-effort).

### Delete a document (by UUID)

```bash
curl -X DELETE http://localhost:3000/api/knowledge/document/YOUR-DOCUMENT-UUID \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{ "clientId": "00000000-0000-0000-0000-000000000001" }'
```

---

## Local Testing — Portal Upload Flow

1. **Upload a test file** to the `aikb-documents` bucket in Supabase Storage.  
   Path example: `uploads/<clientId>/sample_plain.txt`

2. **Set test env vars** in `.env`:
   ```
   TEST_CLIENT_ID=<a valid active client UUID from Relativity_Global>
   TEST_FILE_ID=test-portal-upload-001
   TEST_FILE_NAME=sample_plain.txt
   TEST_MIME_TYPE=text/plain
   TEST_STORAGE_PATH=uploads/<clientId>/sample_plain.txt
   ```

3. **Trigger ingestion**:
   ```bash
   node test/triggerPortalIngest.js
   ```

4. **Watch the Inngest dashboard** at `http://localhost:8288` — all steps should complete successfully.

5. **Confirm the document is indexed**:
   ```bash
   curl http://localhost:3000/api/knowledge/documents/<clientId> -H "x-api-key: $API_KEY"
   ```
   The response should include the document with `"status": "indexed"` and `"source_provider": "portal_upload"`.

6. **Query the knowledge base**:
   ```bash
   curl -X POST http://localhost:3000/api/knowledge/query \
     -H "Content-Type: application/json" \
     -H "x-api-key: $API_KEY" \
     -d '{ "clientId": "<clientId>", "question": "What is the onboarding process?" }'
   ```
   The `sources` array should include `"fileName": "sample_plain.txt"`.

7. **Test deletion**:
   ```bash
   curl -X DELETE http://localhost:3000/api/knowledge/document/by-source \
     -H "Content-Type: application/json" \
     -H "x-api-key: $API_KEY" \
     -d '{
       "clientId": "<clientId>",
       "sourceFileId": "test-portal-upload-001",
       "sourceProvider": "portal_upload"
     }'
   ```
   Confirm the document no longer appears in the listing and the file is removed from Storage.

---

## Architecture

> Google Drive sync has been intentionally removed to keep the MVP focused on portal-uploaded documents.

```
Portal upload → Supabase Storage
        │
        ▼
POST /api/knowledge/ingest
        │
        ▼
  Inngest event: knowledge/document.ingest
        │
        ▼
  1. Create ingestion job
  2. Check for existing document (dedup)
  3. Mark job running
  4. Download file from Supabase Storage
  5. Parse text (PDF, DOCX, plain text, CSV, Markdown)
  6. Compute SHA-256 content hash
  7. Content hash dedup (skips if unchanged)
  8. Upsert document record
  9. Delete old chunks
  10. Chunk text (4000 chars, 400 char overlap)
  11. Generate embeddings (text-embedding-3-small, batched)
  12. Insert chunks into knowledge_chunks (pgvector)
  13. Mark document indexed
  14. Complete job
        │
        ▼
  POST /api/knowledge/query → vector search → AI answer with citations
```
