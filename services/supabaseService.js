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
    .select('*')
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
  storagePath = undefined
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
// Global client validation (Relativity_Global project)
// ---------------------------------------------------------------------------

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

async function searchChunks(clientId, queryEmbedding, { threshold = 0.15, count = 10 } = {}) {
  const { data, error } = await aikbSupabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_client_id: clientId,
    match_threshold: threshold,
    match_count: count,
  });
  if (error) throw new Error(`searchChunks: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

async function createChatSession(clientId, title) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .insert({ client_id: clientId, title })
    .select()
    .single();
  if (error) throw new Error(`createChatSession: ${error.message}`);
  return data;
}

async function getChatSession(clientId, sessionId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`getChatSession: ${error.message}`);
  return data; // null if not found or belongs to a different client
}

async function listChatSessions(clientId) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .select('id, title, created_at, updated_at')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listChatSessions: ${error.message}`);
  return data;
}

async function updateChatSessionTitle(clientId, sessionId, title) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .select()
    .single();
  if (error) throw new Error(`updateChatSessionTitle: ${error.message}`);
  return data;
}

async function softDeleteChatSession(clientId, sessionId) {
  const now = new Date().toISOString();
  const { error: sessionError } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', sessionId)
    .eq('client_id', clientId);
  if (sessionError) throw new Error(`softDeleteChatSession: ${sessionError.message}`);

  const { error: msgError } = await aikbSupabase
    .from('knowledge_chat_messages')
    .update({ deleted_at: now })
    .eq('session_id', sessionId)
    .eq('client_id', clientId);
  if (msgError) throw new Error(`softDeleteChatSession (messages): ${msgError.message}`);
}

async function softDeleteAllChatHistory(clientId) {
  const now = new Date().toISOString();
  const { error: sessionError } = await aikbSupabase
    .from('knowledge_chat_sessions')
    .update({ deleted_at: now, updated_at: now })
    .eq('client_id', clientId)
    .is('deleted_at', null);
  if (sessionError) throw new Error(`softDeleteAllChatHistory (sessions): ${sessionError.message}`);

  const { error: msgError } = await aikbSupabase
    .from('knowledge_chat_messages')
    .update({ deleted_at: now })
    .eq('client_id', clientId)
    .is('deleted_at', null);
  if (msgError) throw new Error(`softDeleteAllChatHistory (messages): ${msgError.message}`);
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

async function createChatMessage({ clientId, sessionId, role, content, sources = null, metadata = null }) {
  const { data, error } = await aikbSupabase
    .from('knowledge_chat_messages')
    .insert({ client_id: clientId, session_id: sessionId, role, content, sources, metadata })
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

async function createKnowledgeGap({ clientId, sessionId, messageId, question, reason }) {
  const { data, error } = await aikbSupabase
    .from('knowledge_gaps')
    .insert({ client_id: clientId, session_id: sessionId, message_id: messageId, question, reason })
    .select()
    .single();
  if (error) throw new Error(`createKnowledgeGap: ${error.message}`);
  return data;
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
  deleteChunksForDocument,
  insertKnowledgeChunks,
  searchChunks,
  getGlobalClientById,
  requireActiveClient,
  createChatSession,
  getChatSession,
  listChatSessions,
  updateChatSessionTitle,
  softDeleteChatSession,
  softDeleteAllChatHistory,
  createChatMessage,
  listChatMessages,
  createKnowledgeGap,
  getIndexedDocumentByContentHash,
};
