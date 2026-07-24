'use strict';

const crypto = require('crypto');
const { inngest } = require('./client');
const config = require('../config');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const documentParser = require('../services/documentParser');
const chunkService = require('../services/chunkService');
const { runKnowledgeQuery } = require('../services/runKnowledgeQuery');
const relativityDeliverClient = require('../services/relativityDeliverClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tag(jobId, sourceFileId, documentId) {
  const parts = [`srcFile=${sourceFileId}`];
  if (jobId) parts.push(`jobId=${jobId}`);
  if (documentId) parts.push(`docId=${documentId}`);
  return parts.join(' | ');
}

/**
 * Races a promise against a timeout. Throws with a clear message if the
 * timeout fires first so the existing catch block can write error_message.
 */
function withTimeout(ms, label, promise) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(
      () => reject(new Error(`[ingest] TIMEOUT: ${label} did not complete within ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); }
    );
  });
}

// ---------------------------------------------------------------------------
// Function 1: knowledge/document.ingest
//
// Full ingest pipeline for a single document. Idempotent: re-running with
// the same content hash is a no-op unless forceReindex is set.
// ---------------------------------------------------------------------------

const ingestDocument = inngest.createFunction(
  {
    id: 'knowledge-document-ingest',
    name: 'Ingest Knowledge Document',
    concurrency: { limit: 2, key: 'event.data.clientId' },
    retries: 3,
    onFailure: async ({ event, error }) => {
      // Backup log — primary error logging is handled via try/catch inside the function
      console.error('[ingest] onFailure', { error: error.message });
    },
  },
  { event: 'knowledge/document.ingest' },
  async ({ event, step }) => {
    const {
      clientId,
      sourceProvider = 'portal_upload',
      sourceFileId,
      fileName,
      mimeType,
      forceReindex = false,
      storagePath,
      // EM6 (EMAIL_INGESTION.md §14.2) — both optional, null for every
      // existing portal_upload caller. collectionId overrides the "always
      // assign the client's default collection at first insert" behavior;
      // emailMetadata is present only when sourceProvider is gmail/microsoft.
      collectionId = null,
      emailMetadata = null,
    } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (!sourceFileId) throw new Error('sourceFileId is required');
    if (!fileName) throw new Error('fileName is required');
    if (!mimeType) throw new Error('mimeType is required');
    if (!storagePath) throw new Error('storagePath is required');
    if (!['portal_upload', 'gmail', 'microsoft'].includes(sourceProvider)) {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload, gmail, and microsoft.');
    }
    const isEmailSource = sourceProvider === 'gmail' || sourceProvider === 'microsoft';

    let jobId = null;
    let documentId = null;

    // -- Step 1: Create ingestion job record ----------------------------------
    const job = await step.run('create-job', async () => {
      return supabaseService.createIngestionJob(clientId, sourceFileId);
    });
    jobId = job.id;

    try {
      // -- Step 2: Check for existing document (dedup) ------------------------
      console.log(`[ingest] START check-existing | ${tag(jobId, sourceFileId, documentId)}`);
      const t2 = Date.now();
      const existing = await step.run('check-existing', async () => {
        return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
      });
      console.log(`[ingest] END   check-existing | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t2}ms | found=${!!existing}`);

      // -- Step 3: Mark job running -------------------------------------------
      console.log(`[ingest] START update-job-running | ${tag(jobId, sourceFileId, documentId)}`);
      const t3 = Date.now();
      await step.run('update-job-running', async () => {
        await supabaseService.updateIngestionJob(clientId, job.id, { status: 'running' });
      });
      console.log(`[ingest] END   update-job-running | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t3}ms`);

      // -- Step 4: Core indexing (download → parse → hash → dedup → upsert → chunk → embed → insert) --
      //
      // Inngest persists step return values. Keep step outputs small; do not return buffers,
      // parsed document text, chunks, embeddings, or vector rows.
      console.log(`[ingest] START index-document-core | ${tag(jobId, sourceFileId, documentId)}`);
      const tCore = Date.now();
      const coreResult = await step.run('index-document-core', async () => {
        let localDocumentId = null;

        try {
          // Download — 30 s hard timeout
          const dlResult = await withTimeout(
            30_000,
            'index-document-core / downloadFromStorage',
            supabaseService.downloadFromStorage(clientId, storagePath)
          );
          if (dlResult.buffer.length > config.maxUploadBytes) {
            throw new Error(`Uploaded file exceeds max size limit of ${config.maxUploadBytes} bytes`);
          }
          const resolvedMimeType = dlResult.resolvedMimeType || mimeType;

          // Parse — 60 s hard timeout; buffer and parsed text stay local, never serialised
          const parsedResult = await withTimeout(
            60_000,
            'index-document-core / parseDocument',
            documentParser.parseDocument(dlResult.buffer, resolvedMimeType, fileName)
          );
          const parsedText = typeof parsedResult === 'string' ? parsedResult : (parsedResult && parsedResult.text) || '';
          const parsedPages = (parsedResult && typeof parsedResult === 'object' && parsedResult.pages) || null;
          const pageCount = parsedPages ? parsedPages.length : 0;

          console.log(`[ingest] parsed text length=${parsedText.length} | page count=${pageCount || 'n/a'}`);

          if (!parsedText || !parsedText.trim()) throw new Error('Parsed document produced no text');

          // Content hash
          const contentHash = crypto.createHash('sha256').update(parsedText).digest('hex');

          // Unchanged hash — skip if same content re-uploaded (uses `existing` from outer step closure)
          if (existing && existing.content_hash === contentHash && !forceReindex) {
            console.log(`[ingest] SKIP unchanged hash | ${tag(jobId, sourceFileId, null)}`);
            await supabaseService.updateIngestionJob(clientId, job.id, { status: 'completed', documentId: existing.id });
            return { skipped: true, reason: 'content hash unchanged', documentId: existing.id, chunkCount: 0, pageCount, contentHash };
          }

          // Cross-file duplicate content check — disabled for email
          // (EMAIL_INGESTION.md §20): two distinct, legitimately separate
          // emails (templated auto-notifications, boilerplate replies) can
          // share a near-identical body and must not collapse into one
          // indexed document the way two uploads of the same file should.
          // The same-file, unchanged-content skip above (existing.content_hash)
          // is unaffected and remains correct for email.
          if (!forceReindex && !isEmailSource) {
            const contentDuplicate = await supabaseService.getIndexedDocumentByContentHash(
              clientId, sourceProvider, contentHash, sourceFileId
            );
            if (contentDuplicate) {
              console.log(`[ingest] SKIP duplicate content | ${tag(jobId, sourceFileId, null)}`);
              await supabaseService.updateIngestionJob(clientId, job.id, { status: 'completed', documentId: contentDuplicate.id });
              return { skipped: true, reason: 'duplicate content', documentId: contentDuplicate.id, chunkCount: 0, pageCount, contentHash };
            }
          }

          // Upsert document record. collectionId is only resolved/passed on
          // a true first-insert (existing is falsy here) — a reindex of an
          // already-moved document must never reset its collection back to
          // General (see upsertKnowledgeDocument's "only write when truthy"
          // handling of this param). EM6: an explicit collectionId from the
          // caller (a matched email_ingestion_rules.destination_collection_id,
          // §22) takes priority over the default collection.
          let newDocCollectionId;
          if (!existing) {
            newDocCollectionId = collectionId || (await supabaseService.getDefaultCollection(clientId)).id;
          }
          const doc = await supabaseService.upsertKnowledgeDocument(
            clientId, sourceProvider, sourceFileId, fileName, resolvedMimeType, contentHash,
            storagePath || undefined, newDocCollectionId
          );
          localDocumentId = doc.id;

          // Delete old chunks — clean slate for re-index (timeout is also enforced inside deleteChunksForDocument)
          await withTimeout(
            15_000,
            'index-document-core / deleteChunksForDocument',
            supabaseService.deleteChunksForDocument(clientId, localDocumentId)
          );

          // Chunk text — preserve per-page metadata for PDFs
          const baseMetadata = { clientId, fileName, sourceProvider, sourceFileId };
          let chunks = [];
          if (parsedPages && parsedPages.length > 0) {
            let globalIndex = 0;
            for (const page of parsedPages) {
              if (!page.text || !page.text.trim()) continue;
              const pageChunks = chunkService.chunkText(page.text, { ...baseMetadata, pageNumber: page.pageNumber });
              for (const c of pageChunks) {
                chunks.push({ ...c, chunkIndex: globalIndex++ });
              }
            }
          }
          if (!chunks.length) {
            chunks = chunkService.chunkText(parsedText, baseMetadata);
          }
          console.log(`[ingest] chunk count=${chunks.length}`);

          if (!chunks.length) throw new Error('Document produced zero chunks');

          // Generate embeddings — 90 s hard timeout
          const embeddings = await withTimeout(
            90_000,
            'index-document-core / generateEmbeddings',
            openaiService.generateEmbeddings(chunks.map((c) => c.content))
          );
          console.log(`[ingest] embedding count=${embeddings.length}`);

          if (embeddings.length !== chunks.length) {
            throw new Error(`Embedding count mismatch: got ${embeddings.length}, expected ${chunks.length}`);
          }

          // Build and insert rows
          const rows = chunks.map((chunk, i) => ({
            document_id: localDocumentId,
            client_id: clientId,
            chunk_index: chunk.chunkIndex,
            content: chunk.content,
            embedding: embeddings[i],
            metadata: chunk.metadata,
          }));
          await supabaseService.insertKnowledgeChunks(clientId, rows);
          console.log(`[ingest] inserted chunk count=${rows.length}`);

          return {
            documentId: localDocumentId,
            contentHash,
            chunkCount: chunks.length,
            pageCount,
            skipped: false,
            reason: null,
          };

        } catch (err) {
          // Write document error before re-throwing so the DB stays consistent
          // even when Inngest retries exhaust and the outer catch can't see localDocumentId.
          if (localDocumentId) {
            await supabaseService.markDocumentError(clientId, localDocumentId, err.message).catch((dbErr) => {
              console.error('[ingest] markDocumentError failed:', dbErr.message);
            });
          }
          throw err;
        }
      });

      console.log(
        `[ingest] END   index-document-core | ${tag(jobId, sourceFileId, coreResult.documentId || null)}` +
        ` | elapsed=${Date.now() - tCore}ms | skipped=${coreResult.skipped}` +
        (coreResult.skipped ? ` | reason=${coreResult.reason}` : ` | chunkCount=${coreResult.chunkCount} | pageCount=${coreResult.pageCount}`)
      );

      // Set documentId now so the outer catch can mark the document as error
      // if mark-indexed or complete-job fails after the core step succeeds.
      documentId = coreResult.documentId;

      // If skipped (unchanged hash or duplicate content), job was already marked completed inside core step
      if (coreResult.skipped) {
        return coreResult;
      }

      // -- Step 5: Mark document indexed --------------------------------------
      console.log(`[ingest] START mark-indexed | ${tag(jobId, sourceFileId, documentId)}`);
      const t5 = Date.now();
      await step.run('mark-indexed', async () => {
        await supabaseService.markDocumentIndexed(clientId, documentId);
      });
      console.log(`[ingest] END   mark-indexed | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t5}ms`);

      // -- Step 5b (EM6, email only): write email_source_messages ------------
      // Additive, after mark-indexed — never blocks or replaces any existing
      // step (EMAIL_INGESTION.md §14.2). Only runs for a true first-insert/
      // content-changed ingest (the unchanged-hash skip path above returns
      // before this point); re-syncing an unchanged message intentionally
      // leaves its existing email_source_messages row as-is.
      if (isEmailSource && emailMetadata) {
        console.log(`[ingest] START write-email-source-message | ${tag(jobId, sourceFileId, documentId)}`);
        const t5b = Date.now();
        await step.run('write-email-source-message', async () => {
          await supabaseService.upsertEmailSourceMessage(clientId, documentId, emailMetadata, coreResult.contentHash);
        });
        console.log(`[ingest] END   write-email-source-message | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t5b}ms`);
      }

      // -- Step 6: Complete job -----------------------------------------------
      console.log(`[ingest] START complete-job | ${tag(jobId, sourceFileId, documentId)}`);
      const t6 = Date.now();
      await step.run('complete-job', async () => {
        await supabaseService.updateIngestionJob(clientId, job.id, { status: 'completed', documentId });
      });
      console.log(`[ingest] END   complete-job | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t6}ms`);

      return { success: true, documentId, chunkCount: coreResult.chunkCount };

    } catch (err) {
      console.error(`[ingest] ERROR | ${tag(jobId, sourceFileId, documentId)} | ${err.message}`);
      if (jobId) await supabaseService.logIngestionError(clientId, jobId, documentId || null, err);
      if (documentId) {
        await supabaseService.markDocumentError(clientId, documentId, err.message).catch((dbErr) => {
          console.error('[ingest] markDocumentError failed:', dbErr.message);
        });
      }
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Function 2: knowledge/document.delete
//
// Mark a document as deleted and remove its chunks from the vector store.
// Lookup can be by documentId OR (sourceProvider + sourceFileId).
// ---------------------------------------------------------------------------

const deleteDocument = inngest.createFunction(
  {
    id: 'knowledge-document-delete',
    name: 'Delete Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.delete' },
  async ({ event, step }) => {
    const { clientId, documentId: inputDocumentId, sourceFileId, sourceProvider = 'portal_upload' } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (sourceProvider !== 'portal_upload') {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload only.');
    }

    // -- Step 1: Find document ------------------------------------------------
    const doc = await step.run('find-document', async () => {
      if (inputDocumentId) {
        const found = await supabaseService.getKnowledgeDocumentById(clientId, inputDocumentId);
        if (found && found.client_id !== clientId) {
          throw new Error('Document does not belong to client');
        }
        return found;
      }
      return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
    });

    if (!doc) {
      return { skipped: true, reason: 'document not found' };
    }

    // -- Step 2: Delete chunks ------------------------------------------------
    await step.run('delete-chunks', async () => {
      await supabaseService.deleteChunksForDocument(clientId, doc.id);
    });

    // -- Step 3: Mark document deleted ----------------------------------------
    await step.run('mark-deleted', async () => {
      await supabaseService.markDocumentDeleted(clientId, doc.id);
    });

    // -- Step 4 (optional): Remove file from Supabase Storage -----------------
    if (doc.storage_path) {
      await step.run('delete-storage-file', async () => {
        await supabaseService.deleteFromStorage(clientId, doc.storage_path);
      });
    }

    return { success: true, documentId: doc.id };
  }
);

// ---------------------------------------------------------------------------
// Function 3: knowledge/document.reindex
//
// Force re-ingest of a specific document regardless of content hash.
// Emits knowledge/document.ingest with forceReindex: true.
// ---------------------------------------------------------------------------

const reindexDocument = inngest.createFunction(
  {
    id: 'knowledge-document-reindex',
    name: 'Reindex Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.reindex' },
  async ({ event, step }) => {
    const {
      clientId, sourceFileId, sourceProvider = 'portal_upload',
      fileName, mimeType, storagePath,
    } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (!sourceFileId) throw new Error('sourceFileId is required');
    if (sourceProvider !== 'portal_upload') {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload only.');
    }

    const fileMeta = await step.run('validate-file-metadata', async () => {
      if (!fileName || !mimeType || !storagePath) {
        throw new Error('reindex requires fileName, mimeType, and storagePath');
      }
      return { name: fileName, mimeType };
    });

    await step.sendEvent('trigger-ingest', {
      name: 'knowledge/document.ingest',
      data: {
        clientId,
        sourceProvider: 'portal_upload',
        sourceFileId,
        fileName: fileMeta.name,
        mimeType: fileMeta.mimeType,
        forceReindex: true,
        storagePath,
      },
    });

    return { triggered: true, sourceFileId };
  }
);

// ---------------------------------------------------------------------------
// Function 4: knowledge/slack.question.requested
//
// Architecture Review Phase 4, Milestone 4 (§4.8-§4.9). Triggered by
// POST /api/knowledge/ask's fast accept-and-enqueue call. Runs the SAME
// shared RAG pipeline /query uses (services/runKnowledgeQuery.js — not a
// duplicated implementation), then calls back to Relativity's
// POST /api/integrations/slack/deliver with the result. Relativity owns
// ALL Slack-specific formatting and delivery (§4.2) — this function never
// calls Slack's API and never sees a bot token.
//
// step.run granularity matters here: if 'deliver-to-relativity' fails and
// Inngest retries the function, 'run-knowledge-query's already-persisted
// return value is reused rather than re-run (Inngest's own step
// memoization) — no second OpenAI call, no risk of a second
// (differently-worded) answer for the same event.
//
// Backlog M13 (revised): runKnowledgeQuery is called with
// persistConversation: false — Slack conversations (both 'slack' and
// 'slack_dm') are never persisted to knowledge_chat_sessions/
// knowledge_chat_messages. Duplicate-enqueue protection is now claimed
// upstream, before this function ever runs (routes/knowledge.js POST /ask,
// services/supabaseService.js#claimSlackRequest,
// migrations/009_slack_request_log.sql) rather than via a session lookup
// here. This function marks that same knowledge_slack_request_log row
// delivered/failed once it knows the outcome — operational metadata only,
// never the question/answer/citations.
// ---------------------------------------------------------------------------

const slackQuestionRequested = inngest.createFunction(
  {
    id: 'knowledge-slack-question-requested',
    name: 'Answer Slack Question',
    concurrency: { limit: 5, key: 'event.data.clientId' },
    retries: 3,
    onFailure: async ({ event, error }) => {
      // Inngest's own retries are exhausted — this is the "AIKB generation
      // failure" path (ADR-007, Relativity's Architecture repo): tell
      // Relativity now so it can post the safe "couldn't complete that
      // request" fallback from this callback. There is no scheduled sweep
      // on Relativity's side to notice this instead (removed per ADR-007) —
      // this callback is the only notification path for this failure mode.
      const { clientId, idempotencyKey } = (event && event.data && event.data.event && event.data.event.data) || {};
      console.error('[slack-question] onFailure', { clientId, error: error && error.message });
      if (clientId && idempotencyKey) {
        try {
          await relativityDeliverClient.deliverResult({
            clientId,
            idempotencyKey,
            payload: { error: true, errorCode: 'AIKB_PROCESSING_FAILED' },
          });
        } catch (deliverErr) {
          console.error('[slack-question] onFailure deliver callback also failed', { error: deliverErr.message });
        }
        // Backlog M13 (revised): terminal failure on the dedup log — a
        // sanitized error category only, never the raw error message.
        // Best-effort: never let this throw and mask the deliver callback
        // above having already run.
        try {
          await supabaseService.markSlackRequestFailed(clientId, idempotencyKey, 'AIKB_PROCESSING_FAILED');
        } catch (markErr) {
          console.error('[slack-question] onFailure markSlackRequestFailed also failed', { error: markErr.message });
        }
      }
    },
  },
  { event: 'knowledge/slack.question.requested' },
  async ({ event, step }) => {
    const { clientId, question, idempotencyKey, origin, originMetadata, allowedCollectionIds } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (!question) throw new Error('question is required');
    if (!idempotencyKey) throw new Error('idempotencyKey is required');

    const result = await step.run('run-knowledge-query', async () => {
      return runKnowledgeQuery({
        clientId,
        question,
        // Backlog M13: origin now flows from the /ask request itself
        // (routes/knowledge.js already allowlists it) — default here only
        // covers events enqueued before this field existed.
        origin: origin || 'slack',
        originMetadata,
        idempotencyKey,
        // Fail-closed: always an explicit array by the time /ask enqueued
        // this event (see routes/knowledge.js POST /ask), but re-guarded
        // here too rather than trusting event.data shape blindly.
        allowedCollectionIds: Array.isArray(allowedCollectionIds) ? allowedCollectionIds : [],
        // Backlog M13 (revised): Slack conversations are never persisted —
        // no knowledge_chat_sessions/knowledge_chat_messages row for
        // either 'slack' or 'slack_dm'. Duplicate-enqueue protection for
        // this idempotencyKey already happened upstream, at claim time in
        // routes/knowledge.js POST /ask.
        persistConversation: false,
      });
    });

    await step.run('deliver-to-relativity', async () => {
      await relativityDeliverClient.deliverResult({
        clientId,
        idempotencyKey,
        payload: {
          answer: result.answer,
          sources: result.sources,
          isKnowledgeGap: result.isKnowledgeGap,
          gapReason: result.gapReason || null,
          sessionId: result.sessionId,
        },
      });
    });

    // Backlog M13 (revised): terminal, operational-metadata-only status —
    // never the answer/sources themselves (those already went out via the
    // deliver-to-relativity step above and are not re-stored here).
    await step.run('mark-request-delivered', async () => {
      await supabaseService.markSlackRequestDelivered(clientId, idempotencyKey);
    });

    return { delivered: true, sessionId: result.sessionId, isKnowledgeGap: result.isKnowledgeGap };
  }
);

const functions = [ingestDocument, deleteDocument, reindexDocument, slackQuestionRequested];

module.exports = { functions, ingestDocument, deleteDocument, reindexDocument, slackQuestionRequested };
