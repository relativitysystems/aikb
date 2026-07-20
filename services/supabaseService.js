'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const aikbSupabase = createClient(
  config.supabase.aikb.url,
  config.supabase.aikb.serviceKey
);

const globalSupabase = createClient(
  config.supabase.global.url,
  config.supabase.global.serviceKey
);

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------

async function downloadFromStorage(storagePath) {
  const bucket = config.storage.bucket;
  const { data, error } = await aikbSupabase.storage
    .from(bucket)
    .download(storagePath);
  if (error) throw new Error(`downloadFromStorage: ${error.message} (path: ${storagePath})`);
  if (!data) throw new Error(`downloadFromStorage: no data returned for path: ${storagePath}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  // Use Blob content-type if meaningful; caller falls back to event mimeType otherwise
  const resolvedMimeType =
    data.type && data.type !== 'application/octet-stream' ? data.type : null;
  return { buffer, resolvedMimeType };
}

async function deleteFromStorage(storagePath) {
  const bucket = config.storage.bucket;
  const { error } = await aikbSupabase.storage.from(bucket).remove([storagePath]);
  if (error) {
    console.warn(`[deleteFromStorage] Could not remove ${storagePath}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Ingestion jobs
// ---------------------------------------------------------------------------

async function createIngestionJob(clientId, sourceFileId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_ingestion_jobs')
    .insert({ client_id: clientId, source_file_id: sourceFileId, status: 'queued' })
    .select()
    .single();
  if (error) throw new Error(`createIngestionJob: ${error.message}`);
  return data;
}

async function updateIngestionJob(jobId, { status, errorMessage, documentId } = {}) {
  const patch = { updated_at: new Date().toISOString() };
  if (status !== undefined) patch.status = status;
  if (errorMessage !== undefined) patch.error_message = errorMessage;
  if (documentId !== undefined) patch.document_id = documentId;

  const { error } = await aikbSupabase
    .from('knowledge_ingestion_jobs')
    .update(patch)
    .eq('id', jobId);
  if (error) throw new Error(`updateIngestionJob: ${error.message}`);
}

async function logIngestionError(jobId, documentId, err) {
  const patch = {
    status: 'failed',
    error_message: err && err.message ? err.message : String(err),
    updated_at: new Date().toISOString(),
  };
  if (documentId) patch.document_id = documentId;

  const { error } = await aikbSupabase
    .from('knowledge_ingestion_jobs')
    .update(patch)
    .eq('id', jobId);
  if (error) console.error('logIngestionError: failed to write error to DB:', error.message);
}

async function getIngestionJobsByClient(clientId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_ingestion_jobs')
    .select('id, client_id, source_file_id, status, error_message, document_id, created_at, updated_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`getIngestionJobsByClient: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function upsertKnowledgeDocument(
  clientId, provider, fileId, fileName, mimeType, contentHash,
  storagePath = undefined, collectionId = undefined
) {
  const now = new Date().toISOString();
  const payload = {
    client_id: clientId,
    source_provider: provider,
    source_file_id: fileId,
    file_name: fileName,
    mime_type: mimeType,
    content_hash: contentHash,
    status: 'indexing',
    updated_at: now,
  };
  if (storagePath) payload.storage_path = storagePath; // only write when truthy; never overwrite with null
  // Only write when truthy; never overwrite with null. Callers only pass this
  // on a true first-insert (see inngest/functions.js) so a reindex of an
  // already-moved document never resets its collection back to General.
  if (collectionId) payload.collection_id = collectionId;
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .upsert(payload, { onConflict: 'client_id,source_provider,source_file_id' })
    .select()
    .single();
  if (error) throw new Error(`upsertKnowledgeDocument: ${error.message}`);
  return data;
}

async function getKnowledgeDocumentBySourceId(clientId, provider, fileId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('*')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('source_file_id', fileId)
    .maybeSingle();
  if (error) throw new Error(`getKnowledgeDocumentBySourceId: ${error.message}`);
  return data; // null if not found
}

async function getKnowledgeDocumentById(documentId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('*')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`getKnowledgeDocumentById: ${error.message}`);
  return data;
}

async function getDocumentsByClient(clientId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('*')
    .eq('client_id', clientId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getDocumentsByClient: ${error.message}`);
  return data;
}

async function getClientSummaryData(clientId) {
  const [docsRes, chunksRes, jobsRes, msgsRes, gapsRes] = await Promise.all([
    aikbSupabase
      .from('knowledge_documents')
      .select('status, last_indexed_at')
      .eq('client_id', clientId),
    aikbSupabase
      .from('knowledge_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId),
    aikbSupabase
      .from('knowledge_ingestion_jobs')
      .select('id, source_file_id, status, error_message, document_id, created_at, updated_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(100),
    aikbSupabase
      .from('knowledge_chat_messages')
      .select('created_at')
      .eq('client_id', clientId)
      .eq('role', 'user')
      .is('deleted_at', null),
    aikbSupabase
      .from('knowledge_gaps')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId),
  ]);

  if (docsRes.error) throw new Error(`getClientSummaryData (docs): ${docsRes.error.message}`);
  if (chunksRes.error) throw new Error(`getClientSummaryData (chunks): ${chunksRes.error.message}`);
  if (jobsRes.error) throw new Error(`getClientSummaryData (jobs): ${jobsRes.error.message}`);
  if (msgsRes.error) throw new Error(`getClientSummaryData (msgs): ${msgsRes.error.message}`);
  if (gapsRes.error) throw new Error(`getClientSummaryData (gaps): ${gapsRes.error.message}`);

  const docs = docsRes.data;
  const byStatus = (s) => docs.filter((d) => d.status === s).length;
  const indexedDates = docs
    .filter((d) => d.status === 'indexed' && d.last_indexed_at)
    .map((d) => d.last_indexed_at);

  const jobs = jobsRes.data;
  const msgs = msgsRes.data;
  const msgDates = msgs.map((m) => m.created_at);

  return {
    totalDocuments: docs.filter((d) => d.status !== 'deleted').length,
    indexedDocuments: byStatus('indexed'),
    failedDocuments: byStatus('error') + byStatus('failed'),
    indexingDocuments: byStatus('indexing') + byStatus('pending'),
    deletedDocuments: byStatus('deleted'),
    totalChunks: chunksRes.count ?? 0,
    latestIngestionJob: jobs[0] ?? null,
    failedJobsCount: jobs.filter((j) => j.status === 'failed').length,
    totalQuestions: msgs.length,
    totalKnowledgeGaps: gapsRes.count ?? 0,
    lastQuestionAt: msgDates.length ? msgDates.reduce((a, b) => (a > b ? a : b)) : null,
    lastIndexedAt: indexedDates.length ? indexedDates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

async function getClientAnalyticsData(clientId) {
  const [msgsRes, gapsRes, recentGapsRes, failedJobsRes, recentJobsRes] = await Promise.all([
    aikbSupabase
      .from('knowledge_chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('role', 'user')
      .is('deleted_at', null),
    aikbSupabase
      .from('knowledge_gaps')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId),
    aikbSupabase
      .from('knowledge_gaps')
      .select('id, question, reason, status, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10),
    aikbSupabase
      .from('knowledge_ingestion_jobs')
      .select('id, source_file_id, status, error_message, created_at, updated_at')
      .eq('client_id', clientId)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(10),
    aikbSupabase
      .from('knowledge_ingestion_jobs')
      .select('id, source_file_id, status, created_at, updated_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  if (msgsRes.error) throw new Error(`getClientAnalyticsData (msgs): ${msgsRes.error.message}`);
  if (gapsRes.error) throw new Error(`getClientAnalyticsData (gaps): ${gapsRes.error.message}`);
  if (recentGapsRes.error) throw new Error(`getClientAnalyticsData (recent gaps): ${recentGapsRes.error.message}`);
  if (failedJobsRes.error) throw new Error(`getClientAnalyticsData (failed jobs): ${failedJobsRes.error.message}`);
  if (recentJobsRes.error) throw new Error(`getClientAnalyticsData (recent jobs): ${recentJobsRes.error.message}`);

  return {
    totalQuestions: msgsRes.count ?? 0,
    totalKnowledgeGaps: gapsRes.count ?? 0,
    recentKnowledgeGaps: recentGapsRes.data ?? [],
    failedIngestionJobs: failedJobsRes.data ?? [],
    recentIngestionActivity: recentJobsRes.data ?? [],
  };
}

async function getAllIndexedDocumentSourceIds(clientId, provider) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('source_file_id')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('status', 'indexed');
  if (error) throw new Error(`getAllIndexedDocumentSourceIds: ${error.message}`);
  return data.map((row) => row.source_file_id);
}

async function getAllIndexedDocuments(clientId, provider) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('id, source_file_id, content_hash')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('status', 'indexed');
  if (error) throw new Error(`getAllIndexedDocuments: ${error.message}`);
  return data;
}

async function markDocumentIndexed(documentId) {
  const { error } = await aikbSupabase
    .from('knowledge_documents')
    .update({ status: 'indexed', last_indexed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentIndexed: ${error.message}`);
}

async function markDocumentDeleted(documentId) {
  const { error } = await aikbSupabase
    .from('knowledge_documents')
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentDeleted: ${error.message}`);
}

async function markDocumentError(documentId, errorMessage) {
  const { error } = await aikbSupabase
    .from('knowledge_documents')
    .update({ status: 'error', error_message: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentError: ${error.message}`);
}

async function getDistinctClientIds() {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('client_id')
    .neq('status', 'deleted');
  if (error) throw new Error(`getDistinctClientIds: ${error.message}`);
  // Deduplicate in JS since Supabase JS client doesn't expose .distinct()
  const ids = [...new Set(data.map((r) => r.client_id))];
  return ids;
}

// ---------------------------------------------------------------------------
// Knowledge collections (Milestone 5)
//
// Org-scoped (client_id-scoped) grouping for knowledge_documents, used to
// restrict what a given channel (currently: Slack) is allowed to search.
// Every client gets two seeded collections — "General" (is_default: true,
// the fallback target for new uploads) and "Slack" (an ordinary starter
// collection). ensureDefaultCollections is idempotent and safe to call
// unconditionally on every collections read/write path and from the ingest
// pipeline, so a client's collections never depend on a one-time migration
// having covered it (new clients are seeded lazily, on first use).
// ---------------------------------------------------------------------------

async function ensureDefaultCollections(clientId) {
  const { error: upsertError } = await aikbSupabase
    .from('knowledge_collections')
    .upsert(
      [
        { client_id: clientId, name: 'General', is_default: true },
        { client_id: clientId, name: 'Slack', is_default: false },
      ],
      { onConflict: 'client_id,name', ignoreDuplicates: true }
    );
  if (upsertError) throw new Error(`ensureDefaultCollections: ${upsertError.message}`);

  const { data, error } = await aikbSupabase
    .from('knowledge_collections')
    .select('*')
    .eq('client_id', clientId)
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw new Error(`ensureDefaultCollections (reselect): ${error.message}`);
  return data;
}

async function getDefaultCollection(clientId) {
  const collections = await ensureDefaultCollections(clientId);
  return collections.find((c) => c.is_default) || collections[0];
}

async function listCollectionsWithCounts(clientId) {
  const collections = await ensureDefaultCollections(clientId);

  const { data: docs, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('collection_id')
    .eq('client_id', clientId)
    .neq('status', 'deleted');
  if (error) throw new Error(`listCollectionsWithCounts: ${error.message}`);

  const counts = new Map();
  for (const doc of docs || []) {
    counts.set(doc.collection_id, (counts.get(doc.collection_id) || 0) + 1);
  }

  return collections.map((c) => ({ ...c, documentCount: counts.get(c.id) || 0 }));
}

async function getCollectionById(collectionId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_collections')
    .select('*')
    .eq('id', collectionId)
    .maybeSingle();
  if (error) throw new Error(`getCollectionById: ${error.message}`);
  return data;
}

async function createCollection(clientId, name) {
  const { data, error } = await aikbSupabase
    .from('knowledge_collections')
    .insert({ client_id: clientId, name })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      const dupErr = new Error('A collection with this name already exists.');
      dupErr.code = 'DUPLICATE_NAME';
      throw dupErr;
    }
    throw new Error(`createCollection: ${error.message}`);
  }
  return data;
}

async function renameCollection(collectionId, name) {
  const { data, error } = await aikbSupabase
    .from('knowledge_collections')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', collectionId)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      const dupErr = new Error('A collection with this name already exists.');
      dupErr.code = 'DUPLICATE_NAME';
      throw dupErr;
    }
    throw new Error(`renameCollection: ${error.message}`);
  }
  return data;
}

async function deleteCollection(collectionId) {
  const { error } = await aikbSupabase
    .from('knowledge_collections')
    .delete()
    .eq('id', collectionId);
  if (error) {
    if (error.code === '23503') {
      const notEmptyErr = new Error('Collection is not empty.');
      notEmptyErr.code = 'NOT_EMPTY';
      throw notEmptyErr;
    }
    throw new Error(`deleteCollection: ${error.message}`);
  }
}

async function moveDocumentCollection(documentId, collectionId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .update({ collection_id: collectionId, updated_at: new Date().toISOString() })
    .eq('id', documentId)
    .select()
    .single();
  if (error) throw new Error(`moveDocumentCollection: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

async function deleteChunksForDocument(documentId) {
  console.log(`[deleteChunksForDocument] START | docId=${documentId}`);
  const start = Date.now();

  const deletePromise = aikbSupabase
    .from('knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
    .then((result) => result);

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`deleteChunksForDocument timed out after 15s (docId=${documentId})`)),
      15_000
    )
  );

  const { data, error } = await Promise.race([deletePromise, timeout]);

  if (error) {
    console.error(`[deleteChunksForDocument] ERROR | docId=${documentId} | elapsed=${Date.now() - start}ms | ${error.message}`);
    throw new Error(`deleteChunksForDocument: ${error.message}`);
  }

  console.log(`[deleteChunksForDocument] END | docId=${documentId} | elapsed=${Date.now() - start}ms`);

  return data;
}

async function insertKnowledgeChunks(chunks) {
  // chunks: [{ document_id, client_id, chunk_index, content, embedding, metadata }]
  // Batch in groups of 500 to stay within Supabase request size limits
  const BATCH = 500;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const { error } = await aikbSupabase.from('knowledge_chunks').insert(batch);
    if (error) throw new Error(`insertKnowledgeChunks (batch ${i}): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Global client validation + member resolution (Relativity_Global project)
// ---------------------------------------------------------------------------

// Validates a Supabase JWT issued by Relativity_Global's auth service.
// Returns the auth user object ({ id, email, ... }) or null if invalid.
async function validateAuthToken(token) {
  const { data: { user }, error } = await globalSupabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// Looks up a client_members row by (client_id, user_id).
// member_id (row.id) is stored in AIKB as a plain UUID — no FK because
// cross-project foreign keys are not supported in Supabase.
// Returns { id, role } or null if the user is not a member of this client.
async function getMemberByAuthUser(clientId, authUserId) {
  const { data, error } = await globalSupabase
    .from('client_members')
    .select('id, role')
    .eq('client_id', clientId)
    .eq('auth_user_id', authUserId) // auth_user_id = Supabase auth.users.id in Relativity_Global
    .maybeSingle();
  if (error) {
    console.warn(`getMemberByAuthUser: ${error.message}`);
    return null;
  }
  return data;
}

async function getGlobalClientById(clientId) {
  const { data, error } = await globalSupabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new Error(`getGlobalClientById: ${error.message}`);
  return data;
}

async function requireActiveClient(clientId) {
  const client = await getGlobalClientById(clientId);

  if (!client) {
    const err = new Error('Client not found or inactive');
    err.status = 404;
    throw err;
  }

  return client;
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

// allowedCollectionIds: null/undefined = no restriction (searches every
// collection — the portal's behavior). An array (including an empty one)
// restricts the match_knowledge_chunks RPC's own SQL WHERE clause to those
// collections — filtering happens inside that single query, never as an
// app-layer post-filter, so a restricted chunk is never fetched at all.
async function searchChunks(clientId, queryEmbedding, { threshold = 0.15, count = 10, allowedCollectionIds = null } = {}) {
  const { data, error } = await aikbSupabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_client_id: clientId,
    match_threshold: threshold,
    match_count: count,
    match_collection_ids: allowedCollectionIds,
  });
  if (error) throw new Error(`searchChunks: ${error.message}`);
  return data;
}

// Cheap existence check used to decide whether an "unsupported"-classified query
// still deserves a retrieval attempt (see routes/knowledge.js /query).
async function hasIndexedDocuments(clientId) {
  const { count, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'indexed');
  if (error) throw new Error(`hasIndexedDocuments: ${error.message}`);
  return (count ?? 0) > 0;
}

function normalizeTitle(name) {
  return (name || '')
    .replace(/\.[a-z0-9]+$/i, '')     // strip file extension
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds documents whose file name/title is referenced in the question, e.g.
 * "summarize the collaborative response document" -> Collaborative response.docx.
 * Returns matching document ids.
 */
function matchDocumentsByTitle(question, documents) {
  const q = (question || '').toLowerCase();
  const matched = [];
  for (const doc of documents || []) {
    const norm = normalizeTitle(doc.file_name);
    if (!norm) continue;
    if (q.includes(norm)) {
      matched.push(doc.id);
      continue;
    }
    const words = norm.split(' ').filter((w) => w.length > 2);
    if (words.length >= 2 && words.filter((w) => q.includes(w)).length / words.length >= 0.6) {
      matched.push(doc.id);
    }
  }
  return matched;
}

/**
 * Vector search with filename/title-aware boosting: if the question references
 * an indexed document by name, that document's chunks are guaranteed to be
 * included (and ranked first) even if their cosine similarity falls under the
 * default threshold or outside the top-N vector matches.
 */
async function searchChunksWithTitleBoost(clientId, queryEmbedding, question, { threshold = 0.15, count = 10, allowedCollectionIds = null } = {}) {
  const vectorMatches = await searchChunks(clientId, queryEmbedding, { threshold, count, allowedCollectionIds });

  let documents = await getDocumentsByClient(clientId);
  // Scope the title-boost candidate pool the same way the vector-search leg
  // above is scoped, so a restricted document's title can never force its
  // chunks into the result set via this secondary path.
  if (Array.isArray(allowedCollectionIds)) {
    const allowed = new Set(allowedCollectionIds);
    documents = documents.filter((d) => allowed.has(d.collection_id));
  }
  const matchedDocumentIds = matchDocumentsByTitle(question, documents);

  if (!matchedDocumentIds.length) {
    return { chunks: vectorMatches, matchedDocumentIds: [] };
  }

  const { data: titleChunks, error } = await aikbSupabase
    .from('knowledge_chunks')
    .select('id, document_id, content, metadata')
    .in('document_id', matchedDocumentIds)
    .order('chunk_index', { ascending: true })
    .limit(count);
  if (error) throw new Error(`searchChunksWithTitleBoost: ${error.message}`);

  const seen = new Set();
  const chunks = [];
  for (const c of titleChunks || []) {
    seen.add(c.id);
    chunks.push({ ...c, similarity: 1, titleMatched: true });
  }
  for (const c of vectorMatches) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    chunks.push(c);
  }

  return { chunks: chunks.slice(0, count), matchedDocumentIds };
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

// member_id references Relativity_Global.client_members.id — stored as a plain UUID
// because cross-project foreign keys are not supported in Supabase.
// origin/originMetadata/idempotencyKey (Architecture Review Phase 4,
// Milestone 4, migrations/005_slack_origin_tracking.sql) are optional and
// only ever set by non-portal callers (currently: Slack, via
// services/runKnowledgeQuery.js). Portal sessions keep leaving all three
// null, unchanged from before this migration.
async function createChatSession(clientId, title, memberId = null, { origin = null, originMetadata = null, idempotencyKey = null } = {}) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .insert({
      client_id: clientId,
      title,
      member_id: memberId,
      origin,
      origin_metadata: originMetadata,
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();
  if (error) throw new Error(`createChatSession: ${error.message}`);
  return data;
}

// Used only by the Slack /ask path (services/runKnowledgeQuery.js) to
// detect a retried/duplicate delivery (e.g. a redelivered Inngest step, or
// one of Relativity's own bounded in-flow retries around POST /ask, per
// ADR-007 — there is no scheduled sweep re-calling this) and return the
// already-computed answer instead of re-running retrieval/generation.
// idempotency_key is unique (partial index, NULLs excluded), so this
// returns at most one row.
async function getChatSessionByIdempotencyKey(clientId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .select('*')
    .eq('client_id', clientId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`getChatSessionByIdempotencyKey: ${error.message}`);
  return data || null;
}

// memberId + isAdmin control visibility:
//   - memberId set, not admin → only that member's session
//   - memberId null (no auth) or isAdmin → any session for the client (backward compat / admin)
async function getChatSession(clientId, sessionId, memberId = null, isAdmin = false) {
  let query = aikbSupabase
    .from('knowledge_chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('client_id', clientId)
    .is('deleted_at', null);

  if (memberId && !isAdmin) {
    query = query.eq('member_id', memberId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getChatSession: ${error.message}`);
  return data; // null if not found, wrong client, or wrong member
}

// memberId set, not admin → only that member's sessions (existing null-member_id rows hidden).
// memberId null (no auth) or isAdmin → all non-deleted sessions for the client.
async function listChatSessions(clientId, memberId = null, isAdmin = false) {
  let query = aikbSupabase
    .from('knowledge_chat_sessions')
    .select('id, title, created_at, updated_at, member_id')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (memberId && !isAdmin) {
    query = query.eq('member_id', memberId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listChatSessions: ${error.message}`);
  return data;
}

// memberId set, not admin → scope the UPDATE to prevent a member from renaming another's session.
// (getChatSession ownership check runs before this in the route, so this is defense in depth.)
async function updateChatSessionTitle(clientId, sessionId, title, memberId = null, isAdmin = false) {
  let query = aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('client_id', clientId)
    .is('deleted_at', null);

  if (memberId && !isAdmin) {
    query = query.eq('member_id', memberId);
  }

  const { data, error } = await query.select().single();
  if (error) throw new Error(`updateChatSessionTitle: ${error.message}`);
  return data;
}

// memberId set, not admin → scope delete to that member's session (defense in depth;
// getChatSession ownership check should have already run before this).
// memberId null or isAdmin → delete by client + session only.
async function softDeleteChatSession(clientId, sessionId, memberId = null, isAdmin = false) {
  const now = new Date().toISOString();

  let sessionQuery = aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', sessionId)
    .eq('client_id', clientId);

  if (memberId && !isAdmin) {
    sessionQuery = sessionQuery.eq('member_id', memberId);
  }

  const { error: sessionError } = await sessionQuery;
  if (sessionError) throw new Error(`softDeleteChatSession: ${sessionError.message}`);

  // Messages are always scoped by session_id + client_id.
  // Ownership of the session was already validated above.
  const { error: msgError } = await aikbSupabase
    .from('knowledge_chat_messages')
    .update({ deleted_at: now })
    .eq('session_id', sessionId)
    .eq('client_id', clientId);
  if (msgError) throw new Error(`softDeleteChatSession (messages): ${msgError.message}`);
}

// memberId set, not admin → only soft-delete sessions (and messages) owned by that member.
// memberId null (no auth) or isAdmin → soft-delete all history for the client.
async function softDeleteAllChatHistory(clientId, memberId = null, isAdmin = false) {
  const now = new Date().toISOString();

  let sessionQuery = aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ deleted_at: now, updated_at: now })
    .eq('client_id', clientId)
    .is('deleted_at', null);

  if (memberId && !isAdmin) {
    sessionQuery = sessionQuery.eq('member_id', memberId);
  }

  const { error: sessionError } = await sessionQuery;
  if (sessionError) throw new Error(`softDeleteAllChatHistory (sessions): ${sessionError.message}`);

  let msgQuery = aikbSupabase
    .from('knowledge_chat_messages')
    .update({ deleted_at: now })
    .eq('client_id', clientId)
    .is('deleted_at', null);

  if (memberId && !isAdmin) {
    msgQuery = msgQuery.eq('member_id', memberId);
  }

  const { error: msgError } = await msgQuery;
  if (msgError) throw new Error(`softDeleteAllChatHistory (messages): ${msgError.message}`);
}

// ADR-007 (Relativity's Architecture repo, decisions/ADR-007-SLACK-BOUNDED-DELIVERY-RETRY.md):
// called by Relativity once a Slack event reaches the terminal
// delivery_failed state, via POST /api/knowledge/chat/redact
// (routes/knowledge.js). Redacts the customer content of the chat session
// tied to this idempotency key — title, and every message's content/
// sources/metadata (which carries the question, retrieval query, and
// chunk/document references used to build the prompt) — while leaving the
// session and message rows themselves in place: their ids, timestamps,
// client_id/session_id linkage, origin/origin_metadata, and idempotency_key
// are all technical/audit metadata, not customer content, and are exactly
// what ADR-007 requires to be retained. knowledge_chat_messages.content is
// NOT NULL, so it is replaced with a fixed redaction marker rather than
// nulled, unlike the nullable session title.
//
// Idempotent and safe to call more than once (e.g. a retried /deliver
// callback after a redaction already succeeded): a session with no
// remaining un-redacted content is simply updated again with the same
// values.
const REDACTED_MESSAGE_CONTENT = '[redacted — Slack delivery failed, see ADR-007]';

async function redactChatSessionByIdempotencyKey(clientId, idempotencyKey) {
  const session = await getChatSessionByIdempotencyKey(clientId, idempotencyKey);
  if (!session) {
    return { redacted: false, reason: 'not_found' };
  }

  const { error: sessionError } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ title: null, updated_at: new Date().toISOString() })
    .eq('id', session.id)
    .eq('client_id', clientId);
  if (sessionError) throw new Error(`redactChatSessionByIdempotencyKey (session): ${sessionError.message}`);

  const { error: messagesError } = await aikbSupabase
    .from('knowledge_chat_messages')
    .update({ content: REDACTED_MESSAGE_CONTENT, sources: null, metadata: null })
    .eq('session_id', session.id)
    .eq('client_id', clientId);
  if (messagesError) throw new Error(`redactChatSessionByIdempotencyKey (messages): ${messagesError.message}`);

  return { redacted: true, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

// member_id is denormalised here (same as client_id) for fast member-scoped queries
// without joining knowledge_chat_sessions. References Relativity_Global.client_members.id.
async function createChatMessage({ clientId, sessionId, role, content, sources = null, metadata = null, memberId = null }) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_messages')
    .insert({ client_id: clientId, session_id: sessionId, role, content, sources, metadata, member_id: memberId })
    .select()
    .single();
  if (error) throw new Error(`createChatMessage: ${error.message}`);

  // Keep the parent session's updated_at current so list ordering reflects activity
  const { error: sessionError } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('client_id', clientId);
  if (sessionError) throw new Error(`createChatMessage (session update): ${sessionError.message}`);

  return data;
}

async function listChatMessages(clientId, sessionId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_messages')
    .select('*')
    .eq('client_id', clientId)
    .eq('session_id', sessionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listChatMessages: ${error.message}`);
  return data;
}

// Fetches the most recent `limit` non-deleted messages for a session, returned
// oldest-first. Used to give the intent classifier/retrieval query builder
// short-term conversation context without loading full session history.
async function listRecentChatMessages(clientId, sessionId, limit = 8) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_messages')
    .select('id, role, content, created_at')
    .eq('client_id', clientId)
    .eq('session_id', sessionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentChatMessages: ${error.message}`);
  return (data || []).reverse();
}

// ---------------------------------------------------------------------------
// Duplicate content detection
// ---------------------------------------------------------------------------

async function getIndexedDocumentByContentHash(clientId, provider, contentHash, excludeSourceFileId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_documents')
    .select('id, source_file_id')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('content_hash', contentHash)
    .eq('status', 'indexed')
    .neq('source_file_id', excludeSourceFileId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getIndexedDocumentByContentHash: ${error.message}`);
  return data || null;
}

// ---------------------------------------------------------------------------
// Knowledge gaps
// ---------------------------------------------------------------------------

// member_id references Relativity_Global.client_members.id — plain UUID, no FK.
async function createKnowledgeGap({ clientId, sessionId, messageId, question, reason, memberId = null }) {
  const { data, error } = await aikbSupabase
    .from('knowledge_gaps')
    .insert({ client_id: clientId, session_id: sessionId, message_id: messageId, question, reason, member_id: memberId })
    .select()
    .single();
  if (error) throw new Error(`createKnowledgeGap: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Client-wide hard delete (cleanup)
// Called by the internal /client/:clientId cleanup route AFTER the Global
// clients row may already be gone — must never depend on requireActiveClient
// or any Global DB lookup succeeding. Every step below is independent and
// non-fatal so reruns on a partially-cleaned client are safe.
// ---------------------------------------------------------------------------

async function deleteStorageForClient(clientId) {
  const bucket = config.storage.bucket;
  const prefix = `uploads/${clientId}`;
  const limit = 1000;
  let offset = 0;
  const names = [];
  while (true) {
    const { data, error } = await aikbSupabase.storage.from(bucket).list(prefix, { limit, offset });
    if (error) {
      console.warn(`[deleteStorageForClient] list failed for ${prefix}: ${error.message}`);
      return { removed: 0, errors: [error.message] };
    }
    if (!data || data.length === 0) break;
    names.push(...data.map((f) => f.name));
    if (data.length < limit) break;
    offset += limit;
  }
  if (names.length === 0) return { removed: 0, errors: [] };

  const paths = names.map((n) => `${prefix}/${n}`);
  const errors = [];
  let removed = 0;
  for (let i = 0; i < paths.length; i += 1000) {
    const batch = paths.slice(i, i + 1000);
    const { data, error } = await aikbSupabase.storage.from(bucket).remove(batch);
    if (error) {
      console.warn(`[deleteStorageForClient] remove batch failed: ${error.message}`);
      errors.push(error.message);
    } else {
      removed += (data || batch).length;
    }
  }
  return { removed, errors };
}

async function deleteAllClientData(clientId) {
  console.log(`[deleteAllClientData] START | clientId=${clientId}`);
  const errors = [];

  const storage = await deleteStorageForClient(clientId);
  errors.push(...storage.errors.map((e) => `storage: ${e}`));
  console.log(`[deleteAllClientData] storage removed=${storage.removed} errors=${storage.errors.length}`);

  // Children before parents — defensive given the live schema may drift
  // from this repo's tracked migrations; don't rely solely on cascade.
  const tables = [
    'knowledge_gaps',
    'knowledge_chat_messages',
    'knowledge_chat_sessions',
    'knowledge_chunks',
    'knowledge_ingestion_jobs',
    'knowledge_documents',
    // Must come after knowledge_documents — collection_id is a real FK
    // (ON DELETE RESTRICT) within this same database, unlike the other
    // cross-project columns in this file.
    'knowledge_collections',
  ];
  const tableResults = {};
  for (const table of tables) {
    const { error, count } = await aikbSupabase.from(table).delete({ count: 'exact' }).eq('client_id', clientId);
    if (error) {
      console.error(`[deleteAllClientData] ${table} delete failed: ${error.message}`);
      errors.push(`${table}: ${error.message}`);
      tableResults[table] = { error: error.message };
    } else {
      console.log(`[deleteAllClientData] ${table} deleted count=${count ?? 'n/a'}`);
      tableResults[table] = { deleted: count ?? null };
    }
  }

  console.log(`[deleteAllClientData] DONE | clientId=${clientId} | errors=${errors.length}`);
  return { storage, tables: tableResults, errors };
}

module.exports = {
  downloadFromStorage,
  deleteFromStorage,
  createIngestionJob,
  updateIngestionJob,
  logIngestionError,
  getIngestionJobsByClient,
  upsertKnowledgeDocument,
  getKnowledgeDocumentBySourceId,
  getKnowledgeDocumentById,
  getDocumentsByClient,
  getAllIndexedDocumentSourceIds,
  getAllIndexedDocuments,
  markDocumentIndexed,
  markDocumentDeleted,
  markDocumentError,
  getDistinctClientIds,
  ensureDefaultCollections,
  getDefaultCollection,
  listCollectionsWithCounts,
  getCollectionById,
  createCollection,
  renameCollection,
  deleteCollection,
  moveDocumentCollection,
  deleteChunksForDocument,
  insertKnowledgeChunks,
  searchChunks,
  hasIndexedDocuments,
  matchDocumentsByTitle,
  searchChunksWithTitleBoost,
  getGlobalClientById,
  requireActiveClient,
  validateAuthToken,
  getMemberByAuthUser,
  createChatSession,
  getChatSessionByIdempotencyKey,
  getChatSession,
  listChatSessions,
  updateChatSessionTitle,
  softDeleteChatSession,
  softDeleteAllChatHistory,
  redactChatSessionByIdempotencyKey,
  createChatMessage,
  listChatMessages,
  listRecentChatMessages,
  createKnowledgeGap,
  getIndexedDocumentByContentHash,
  getClientSummaryData,
  getClientAnalyticsData,
  deleteAllClientData,
};
