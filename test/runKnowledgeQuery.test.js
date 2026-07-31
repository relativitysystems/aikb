'use strict';

// Pre-existing gap fixed here rather than left for a later pass: this file
// requires services/runKnowledgeQuery.js (which pulls in config/index.js's
// require_env checks) but, unlike its sibling test files (e.g.
// toolExecutionClient.test.js), never set the env vars config/index.js
// needs to not throw at require time. Harmless in isolation (env vars
// leaking from another test file's process happened to mask this when run
// via certain invocations) but a real gap when this file runs on its own
// or first in process-isolated `node --test`. Same var set/values as
// toolExecutionClient.test.js's own bootstrap block.
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.API_KEY = process.env.API_KEY || 'test-api-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.RELATIVITY_API_BASE_URL = process.env.RELATIVITY_API_BASE_URL || 'https://relativity.example.internal';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runKnowledgeQuery } = require('../services/runKnowledgeQuery');
const { buildGapIdempotencyKey } = require('../services/knowledgeGapKey');

const CLIENT_ID = 'client-1';

/**
 * A minimal in-memory fake of the subset of supabaseService.js used by
 * runKnowledgeQuery — this repo has no test-database pattern, and this
 * mirrors the DI-against-a-fake approach already used on the Relativity
 * side (services/oauthConnectionsService.js's test file) for the same
 * reason: exercising real dedup/lookup semantics without a live database.
 */
function createFakeSupabaseService() {
  const sessions = new Map();
  const messages = [];
  const gapsByIdempotencyKey = new Map();
  let nextSessionId = 1;
  let nextMessageId = 1;
  let nextGapId = 1;

  return {
    calls: { createChatSession: 0, createChatMessage: 0, createKnowledgeGap: 0 },
    // Mirrors supabaseService.js#createKnowledgeGap's real upsert-on-conflict
    // semantics (in-memory, keyed on idempotencyKey) so dedup behavior is
    // actually exercised, not just stubbed out.
    async createKnowledgeGap(args) {
      this.calls.createKnowledgeGap += 1;
      const key = args.idempotencyKey;
      if (key && gapsByIdempotencyKey.has(key)) {
        const existing = gapsByIdempotencyKey.get(key);
        existing.reason = args.reason;
        existing.session_id = args.sessionId;
        existing.message_id = args.messageId;
        return existing;
      }
      const gap = {
        id: `gap-${nextGapId++}`, client_id: args.clientId, session_id: args.sessionId,
        message_id: args.messageId, question: args.question, reason: args.reason,
        member_id: args.memberId, origin: args.origin, origin_metadata: args.originMetadata,
        idempotency_key: key, reported_by: args.reportedBy, status: 'open',
      };
      if (key) gapsByIdempotencyKey.set(key, gap);
      return gap;
    },
    async getChatSessionByIdempotencyKey(clientId, idempotencyKey) {
      for (const session of sessions.values()) {
        if (session.client_id === clientId && session.idempotency_key === idempotencyKey) return session;
      }
      return null;
    },
    async getChatSession(clientId, sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.client_id !== clientId) return null;
      return session;
    },
    async createChatSession(clientId, title, memberId, { origin = null, originMetadata = null, idempotencyKey = null } = {}) {
      this.calls.createChatSession += 1;
      const session = { id: `session-${nextSessionId++}`, client_id: clientId, title, member_id: memberId, origin, origin_metadata: originMetadata, idempotency_key: idempotencyKey };
      sessions.set(session.id, session);
      return session;
    },
    async createChatMessage({ clientId, sessionId, role, content, sources = null, metadata = null, memberId = null }) {
      this.calls.createChatMessage += 1;
      const msg = { id: `msg-${nextMessageId++}`, client_id: clientId, session_id: sessionId, role, content, sources, metadata, member_id: memberId, created_at: new Date().toISOString() };
      messages.push(msg);
      return msg;
    },
    async listRecentChatMessages(clientId, sessionId) {
      return messages.filter((m) => m.client_id === clientId && m.session_id === sessionId);
    },
    async listChatMessages(clientId, sessionId) {
      return messages.filter((m) => m.client_id === clientId && m.session_id === sessionId);
    },
    async hasIndexedDocuments() {
      return true;
    },
    async searchChunksWithTitleBoost() {
      return { chunks: [], matchedDocumentIds: [] };
    },
    // EM10 (§23) — overridden per-test with a fixture; the default (empty)
    // is exercised by every pre-EM10 test here, none of which ever sets
    // metadata.sourceProvider to gmail/microsoft, so runKnowledgeQuery's own
    // emailDocumentIds.length guard means this is never even called for them.
    async getEmailSourceMessagesByDocumentIds() {
      return [];
    },
    _sessions: sessions,
    _messages: messages,
    _gapsByIdempotencyKey: gapsByIdempotencyKey,
  };
}

function createFakeOpenaiService(overrides = {}) {
  return {
    calls: { classifyQueryIntent: 0, generateRagAnswer: 0 },
    async classifyQueryIntent() {
      this.calls.classifyQueryIntent += 1;
      return overrides.intent || { intent: 'question', confidence: 0.9, shouldRunRetrieval: true, reason: 'looks like a question' };
    },
    buildNonRetrievalAnswer(question, intent) {
      return overrides.nonRetrievalAnswer || `Non-retrieval answer for: ${question} (${intent.intent})`;
    },
    async buildRetrievalQuery(question) {
      return overrides.retrievalQuery || question;
    },
    async embedQuery() {
      return [0.1, 0.2, 0.3];
    },
    async generateRagAnswer() {
      this.calls.generateRagAnswer += 1;
      return overrides.ragAnswer || 'You get 15 days of PTO per year.';
    },
  };
}

test('a normal question with retrieved chunks returns a grounded answer with sources', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [{ document_id: 'doc-1', similarity: 0.8, metadata: { fileName: 'PTO.pdf', pageNumber: 2 } }],
    matchedDocumentIds: [],
  });
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is our PTO policy?', origin: 'portal', deps: { supabaseService, openaiService } });

  assert.equal(result.isKnowledgeGap, false);
  assert.equal(result.answer, 'You get 15 days of PTO per year.');
  assert.deepEqual(result.sources, [{ fileName: 'PTO.pdf', documentId: 'doc-1', pages: [2] }]);
  assert.ok(result.sessionId);
  assert.ok(result.userMessageId);
});

// ─────────────────────────────────────────────
// EM10 — email-sourced citations (EMAIL_INGESTION.md §23)
// ─────────────────────────────────────────────

test('an email-sourced chunk resolves email_source_messages and returns a subject/from/sentAt/deepLinkUrl citation, not fileName/pages', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [{ document_id: 'doc-email-1', similarity: 0.8, metadata: { sourceProvider: 'gmail', sourceFileId: 'msg-1' } }],
    matchedDocumentIds: [],
  });
  const emailLookupCalls = [];
  supabaseService.getEmailSourceMessagesByDocumentIds = async (clientId, documentIds) => {
    emailLookupCalls.push({ clientId, documentIds });
    return [{
      document_id: 'doc-email-1', subject: 'Q3 Renewal Terms', from_address: 'jane@client.com',
      from_name: 'Jane Doe', sent_at: '2026-07-20T12:00:00Z', provider_thread_id: 'thread-1',
      deep_link_url: 'https://mail.google.com/mail/u/0/#all/msg-1',
    }];
  };
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What are the renewal terms?', origin: 'portal', deps: { supabaseService, openaiService } });

  assert.equal(emailLookupCalls.length, 1);
  assert.deepEqual(emailLookupCalls[0], { clientId: CLIENT_ID, documentIds: ['doc-email-1'] });
  assert.deepEqual(result.sources, [{
    documentId: 'doc-email-1',
    fileName: 'Q3 Renewal Terms.txt',
    title: '"Q3 Renewal Terms" from Jane Doe',
    subject: 'Q3 Renewal Terms',
    from: 'Jane Doe',
    sentAt: '2026-07-20T12:00:00Z',
    deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/msg-1',
    providerThreadId: 'thread-1',
  }]);
});

test('email lookup is skipped entirely when no retrieved chunk is email-sourced (getEmailSourceMessagesByDocumentIds never called)', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [{ document_id: 'doc-1', similarity: 0.8, metadata: { fileName: 'PTO.pdf', pageNumber: 2 } }],
    matchedDocumentIds: [],
  });
  let lookupCalled = false;
  supabaseService.getEmailSourceMessagesByDocumentIds = async () => { lookupCalled = true; return []; };
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is our PTO policy?', origin: 'portal', deps: { supabaseService, openaiService } });
  assert.equal(lookupCalled, false);
});

test('two chunks from the SAME email document collapse into one citation (dedup by document_id, matching the existing document-source behavior)', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [
      { document_id: 'doc-email-1', similarity: 0.8, metadata: { sourceProvider: 'gmail' } },
      { document_id: 'doc-email-1', similarity: 0.7, metadata: { sourceProvider: 'gmail' } },
    ],
    matchedDocumentIds: [],
  });
  supabaseService.getEmailSourceMessagesByDocumentIds = async () => ([{
    document_id: 'doc-email-1', subject: 'Renewal', from_address: 'jane@client.com', from_name: null,
    sent_at: null, provider_thread_id: null, deep_link_url: null,
  }]);
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'q', origin: 'portal', deps: { supabaseService, openaiService } });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].from, 'jane@client.com'); // falls back to from_address when from_name is null
  assert.ok(!('providerThreadId' in result.sources[0])); // omitted, not null, when the row has no thread id
});

test('a mixed result (one document chunk, one email chunk) returns both citation shapes correctly, each keyed to its own document', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [
      { document_id: 'doc-1', similarity: 0.9, metadata: { fileName: 'Handbook.pdf', pageNumber: 5 } },
      { document_id: 'doc-email-1', similarity: 0.8, metadata: { sourceProvider: 'microsoft' } },
    ],
    matchedDocumentIds: [],
  });
  supabaseService.getEmailSourceMessagesByDocumentIds = async (clientId, documentIds) => {
    assert.deepEqual(documentIds, ['doc-email-1']); // never asked to resolve the non-email document
    return [{ document_id: 'doc-email-1', subject: 'Renewal', from_address: 'jane@client.com', from_name: null, sent_at: null, provider_thread_id: null, deep_link_url: null }];
  };
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'q', origin: 'portal', deps: { supabaseService, openaiService } });
  assert.equal(result.sources.length, 2);
  const doc = result.sources.find((s) => s.documentId === 'doc-1');
  const email = result.sources.find((s) => s.documentId === 'doc-email-1');
  assert.deepEqual(doc, { fileName: 'Handbook.pdf', documentId: 'doc-1', pages: [5] });
  assert.equal(email.subject, 'Renewal');
});

test('no chunks found returns a knowledge-gap result with gapReason no_chunks_found, and auto-persists a system-reported gap', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is the meaning of life?', origin: 'slack', originMetadata: { teamId: 'T1' }, idempotencyKey: 'slack:Ev001', deps: { supabaseService, openaiService } });

  assert.equal(result.isKnowledgeGap, true);
  assert.equal(result.gapReason, 'no_chunks_found');
  assert.equal(supabaseService.calls.createKnowledgeGap, 1, 'runKnowledgeQuery must auto-persist a gap when isKnowledgeGap is true');
  const [gap] = [...supabaseService._gapsByIdempotencyKey.values()];
  assert.equal(gap.reported_by, 'system');
  assert.equal(gap.origin, 'slack');
  assert.equal(gap.reason, 'no_chunks_found');
  assert.match(gap.idempotency_key, /^gap:v1:/);
});

test('a gap-logging failure is swallowed and never breaks the user-facing response', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.createKnowledgeGap = async () => { throw new Error('db unavailable'); };
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is the meaning of life?', deps: { supabaseService, openaiService } });

  assert.equal(result.isKnowledgeGap, true);
  assert.equal(result.gapReason, 'no_chunks_found');
});

test('two questions that are the same after normalization, in the same week, auto-persist onto a single gap row instead of duplicating', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is the meaning of life?', origin: 'portal', deps: { supabaseService, openaiService } });
  await runKnowledgeQuery({ clientId: CLIENT_ID, question: '  what is the meaning of life???  ', origin: 'portal', deps: { supabaseService, openaiService } });

  assert.equal(supabaseService.calls.createKnowledgeGap, 2, 'createKnowledgeGap is called on every detection...');
  assert.equal(supabaseService._gapsByIdempotencyKey.size, 1, '...but both calls resolve to the same row via the shared idempotency key');
});

test('a manually-saved gap (POST /api/knowledge/gaps) targeting the same idempotency key as an auto-persisted one lands on the same row without clobbering status/reported_by', async () => {
  const supabaseService = createFakeSupabaseService();

  const key = buildGapIdempotencyKey({ clientId: CLIENT_ID, question: 'What is our PTO policy?' });
  const systemGap = await supabaseService.createKnowledgeGap({
    clientId: CLIENT_ID, sessionId: 's1', messageId: 'm1', question: 'What is our PTO policy?',
    reason: 'no_chunks_found', origin: 'slack', idempotencyKey: key, reportedBy: 'system',
  });
  systemGap.status = 'reviewed'; // simulate an admin having already reviewed this gap

  const userSave = await supabaseService.createKnowledgeGap({
    clientId: CLIENT_ID, sessionId: 's2', messageId: 'm2', question: 'what is our pto policy?',
    reason: 'user flagged this as wrong', origin: 'portal', idempotencyKey: key, reportedBy: 'user',
  });

  assert.equal(userSave.id, systemGap.id, 'same idempotency key must resolve to the same row');
  assert.equal(userSave.reported_by, 'system', 'reported_by is not overwritten by a later manual save landing on an existing row');
  assert.equal(userSave.status, 'reviewed', 'status is not clobbered by a later manual save landing on an existing row');
  assert.equal(userSave.reason, 'user flagged this as wrong', 'reason IS refreshed on conflict');
});

test('an LLM answer indicating the info was not found is treated as a knowledge gap even with retrieved chunks', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({ chunks: [{ document_id: 'doc-1', similarity: 0.2, metadata: {} }], matchedDocumentIds: [] });
  const openaiService = createFakeOpenaiService({ ragAnswer: "I couldn't find that in the documentation." });

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'irrelevant question', deps: { supabaseService, openaiService } });

  assert.equal(result.isKnowledgeGap, true);
  assert.equal(result.gapReason, 'answer_indicated_not_found');
  assert.equal(result.sources.length, 0);
});

test('a non-retrieval intent (e.g. casual conversation) skips vector search entirely', async () => {
  const supabaseService = createFakeSupabaseService();
  let searchCalled = false;
  supabaseService.searchChunksWithTitleBoost = async () => { searchCalled = true; return { chunks: [], matchedDocumentIds: [] }; };
  const openaiService = createFakeOpenaiService({ intent: { intent: 'casual_conversation', confidence: 0.95, shouldRunRetrieval: false, reason: 'greeting' } });

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'hello!', deps: { supabaseService, openaiService } });

  assert.equal(searchCalled, false);
  assert.equal(result.isConversational, true);
  assert.equal(result.isKnowledgeGap, false);
});

test('origin: slack persists origin/originMetadata/idempotencyKey on the created session', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    originMetadata: { teamId: 'T1', channelId: 'C1', threadTs: '1.0', eventId: 'Ev001' },
    idempotencyKey: 'slack:Ev001',
    deps: { supabaseService, openaiService },
  });

  const session = [...supabaseService._sessions.values()][0];
  assert.equal(session.origin, 'slack');
  assert.equal(session.idempotency_key, 'slack:Ev001');
  assert.deepEqual(session.origin_metadata, { teamId: 'T1', channelId: 'C1', threadTs: '1.0', eventId: 'Ev001' });
});

test('portal origin (no idempotencyKey) never triggers the idempotency short-circuit and behaves exactly as before', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'question one', origin: 'portal', deps: { supabaseService, openaiService } });
  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'question two', origin: 'portal', deps: { supabaseService, openaiService } });

  assert.equal(supabaseService.calls.createChatSession, 2, 'portal calls with no idempotencyKey always create a fresh session');
});

test('a retried call with the same idempotencyKey replays the existing answer instead of re-running the pipeline', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  const first = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    originMetadata: { eventId: 'Ev001' },
    idempotencyKey: 'slack:Ev001',
    deps: { supabaseService, openaiService },
  });

  const second = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    originMetadata: { eventId: 'Ev001' },
    idempotencyKey: 'slack:Ev001',
    deps: { supabaseService, openaiService },
  });

  assert.equal(supabaseService.calls.createChatSession, 1, 'only one session should ever be created for this idempotencyKey');
  assert.equal(openaiService.calls.classifyQueryIntent, 1, 'the pipeline must not run twice for a retried event');
  assert.equal(second.replayed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.answer, first.answer);
});

test('a different idempotencyKey is never short-circuited by an unrelated session', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'q1', origin: 'slack', idempotencyKey: 'slack:Ev001', deps: { supabaseService, openaiService } });
  await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'q2', origin: 'slack', idempotencyKey: 'slack:Ev002', deps: { supabaseService, openaiService } });

  assert.equal(supabaseService.calls.createChatSession, 2);
});

test('a request for an unknown providedSessionId throws a 404-shaped error', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await assert.rejects(
    () => runKnowledgeQuery({ clientId: CLIENT_ID, question: 'x', sessionId: 'does-not-exist', deps: { supabaseService, openaiService } }),
    (err) => err.status === 404
  );
});

test('retrieval is scoped strictly to the requesting client (client_id passed through unmodified)', async () => {
  const supabaseService = createFakeSupabaseService();
  let capturedClientId;
  supabaseService.searchChunksWithTitleBoost = async (clientId) => { capturedClientId = clientId; return { chunks: [], matchedDocumentIds: [] }; };
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({ clientId: 'client-isolated', question: 'x', deps: { supabaseService, openaiService } });
  assert.equal(capturedClientId, 'client-isolated');
});

// Backlog M13 (revised): persistConversation: false is how Slack-originated
// questions (both 'slack' and 'slack_dm') are now run — no
// knowledge_chat_sessions row and no knowledge_chat_messages rows are ever
// created. Dedup for retried/duplicate calls moves to the caller
// (routes/knowledge.js POST /ask + services/supabaseService.js#claimSlackRequest,
// see test/slackRequestLogService.test.js), so runKnowledgeQuery no longer
// needs (or performs) a session-based idempotency short-circuit in this mode.

test('persistConversation: false never creates a chat session or chat messages, for a normal grounded answer', async () => {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({
    chunks: [{ document_id: 'doc-1', similarity: 0.8, metadata: { fileName: 'PTO.pdf', pageNumber: 2 } }],
    matchedDocumentIds: [],
  });
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    idempotencyKey: 'slack:Ev001',
    persistConversation: false,
    deps: { supabaseService, openaiService },
  });

  assert.equal(supabaseService.calls.createChatSession, 0, 'no knowledge_chat_sessions row may ever be created for Slack');
  assert.equal(supabaseService.calls.createChatMessage, 0, 'no knowledge_chat_messages row may ever be created for Slack');
  assert.equal(result.answer, 'You get 15 days of PTO per year.');
  assert.equal(result.sessionId, null);
  assert.equal(result.userMessageId, null);
});

test('persistConversation: false never creates a session/message even on the no-non-retrieval-answer path', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService({ intent: { intent: 'casual_conversation', confidence: 0.95, shouldRunRetrieval: false, reason: 'greeting' } });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'hello!',
    origin: 'slack_dm',
    idempotencyKey: 'slack:Ev002',
    persistConversation: false,
    deps: { supabaseService, openaiService },
  });

  assert.equal(supabaseService.calls.createChatSession, 0);
  assert.equal(supabaseService.calls.createChatMessage, 0);
  assert.equal(result.isConversational, true);
});

test('persistConversation: false still auto-persists a knowledge_gaps row with the real question when a gap is detected (product decision: gap review data is exempt)', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is the meaning of life?',
    origin: 'slack',
    originMetadata: { teamId: 'T1' },
    idempotencyKey: 'slack:Ev003',
    persistConversation: false,
    deps: { supabaseService, openaiService },
  });

  assert.equal(result.isKnowledgeGap, true);
  assert.equal(supabaseService.calls.createChatSession, 0);
  assert.equal(supabaseService.calls.createChatMessage, 0);
  assert.equal(supabaseService.calls.createKnowledgeGap, 1, 'a detected gap must still be logged, even for Slack under persistConversation: false');

  const [gap] = [...supabaseService._gapsByIdempotencyKey.values()];
  assert.equal(gap.question, 'What is the meaning of life?', 'the real question text is retained on a detected gap by product decision');
  assert.equal(gap.session_id, null, 'no session exists to reference');
  assert.equal(gap.message_id, null, 'no message exists to reference');
});

test('persistConversation: false skips the idempotency-based session-replay short-circuit — the pipeline runs every time (dedup is the caller\'s job)', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();

  await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    idempotencyKey: 'slack:Ev004',
    persistConversation: false,
    deps: { supabaseService, openaiService },
  });
  const second = await runKnowledgeQuery({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    origin: 'slack',
    idempotencyKey: 'slack:Ev004',
    persistConversation: false,
    deps: { supabaseService, openaiService },
  });

  assert.equal(openaiService.calls.classifyQueryIntent, 2, 'no session exists to replay from, so the pipeline runs on every call');
  assert.equal(second.replayed, undefined);
});

// ─────────────────────────────────────────────
// EL5 — bounded live-email tool orchestration
// (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §1, §1.3 Option C,
// ADR-010 Conformance's confirmed two-call bound)
// ─────────────────────────────────────────────

const MEMBER_ID = 'member-1';

function intentWithGate(mayNeedLiveEmailLookup, overrides = {}) {
  return { intent: 'knowledge_query', confidence: 0.9, shouldRunRetrieval: true, mayNeedLiveEmailLookup, reason: 'test', ...overrides };
}

/**
 * A scripted fake covering classifyQueryIntent/generateRagAnswer (the
 * unchanged no-tools path) AND the two new EL5 tools-aware functions.
 * `toolScript` drives generateRagAnswerWithTools/continueRagAnswerWithToolResult
 * in call order: each entry is either {type:'text', content} (answer
 * immediately, no further calls) or {type:'tool_call', name, args}
 * (request a tool, continuing the script on the next orchestration call).
 * conversationMessages carries a minimal, opaque marker forward — nothing
 * in the orchestrator inspects its shape beyond passing it back to the next
 * call, mirroring the real OpenAI message-array contract.
 */
function createScriptedToolOpenaiService({ intent, ragAnswer = 'stored-only answer', toolScript = [] }) {
  let step = 0;
  const calls = { classifyQueryIntent: 0, generateRagAnswer: 0, generateRagAnswerWithTools: 0, continueRagAnswerWithToolResult: 0 };
  const receivedToolResults = [];
  const offeredToolsPerCall = [];

  function nextResult(tools) {
    offeredToolsPerCall.push((tools || []).map((t) => t.function.name));
    const scripted = toolScript[step];
    step += 1;
    if (!scripted || scripted.type === 'text') {
      return { type: 'text', content: (scripted && scripted.content) || ragAnswer };
    }
    return {
      type: 'tool_call',
      conversationMessages: [{ marker: `after-call-${step}` }],
      toolCall: { id: `call-${step}`, name: scripted.name, args: scripted.args || {} },
    };
  }

  return {
    calls,
    receivedToolResults,
    offeredToolsPerCall,
    async classifyQueryIntent() {
      calls.classifyQueryIntent += 1;
      return intent;
    },
    buildNonRetrievalAnswer(question, intentArg) {
      return `Non-retrieval answer for: ${question} (${intentArg.intent})`;
    },
    async buildRetrievalQuery(question) { return question; },
    async embedQuery() { return [0.1, 0.2, 0.3]; },
    async generateRagAnswer() {
      calls.generateRagAnswer += 1;
      return ragAnswer;
    },
    async generateRagAnswerWithTools(question, chunks, sessionMessages, tools) {
      calls.generateRagAnswerWithTools += 1;
      return nextResult(tools);
    },
    async continueRagAnswerWithToolResult({ toolResult, tools }) {
      calls.continueRagAnswerWithToolResult += 1;
      receivedToolResults.push(toolResult);
      return nextResult(tools);
    },
  };
}

function createFakeToolExecutionClient(responsesByToolName = {}) {
  const calls = [];
  return {
    calls,
    async executeTool(params) {
      calls.push(params);
      const responder = responsesByToolName[params.toolName];
      if (typeof responder === 'function') return responder(params);
      return responder || { status: 'ok', matches: [] };
    },
  };
}

function baseSupabaseServiceWithChunks(chunks = []) {
  const supabaseService = createFakeSupabaseService();
  supabaseService.searchChunksWithTitleBoost = async () => ({ chunks, matchedDocumentIds: [] });
  return supabaseService;
}

test('gate-closed (classifier says no): generateRagAnswerWithTools/executeTool are never reached, plain generateRagAnswer is used', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([{ document_id: 'doc-1', metadata: { fileName: 'PTO.pdf' } }]);
  // Deliberately the OLD fixture (no generateRagAnswerWithTools defined) —
  // if the orchestrator incorrectly tried the tools path, this throws.
  const openaiService = createFakeOpenaiService({ intent: intentWithGate(false), ragAnswer: 'PTO answer' });
  const toolExecutionClient = createFakeToolExecutionClient();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'What is our PTO policy?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(openaiService.calls.generateRagAnswer, 1);
  assert.equal(toolExecutionClient.calls.length, 0);
  assert.equal(result.answer, 'PTO answer');
  assert.equal(result.isKnowledgeGap, false);
});

test('gate-closed with zero stored chunks: the unchanged immediate gap shortcut fires, generateRagAnswer is never even called', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]);
  const openaiService = createFakeOpenaiService({ intent: intentWithGate(false) });
  const toolExecutionClient = createFakeToolExecutionClient();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'What is our PTO policy?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(openaiService.calls.generateRagAnswer, 0);
  assert.equal(toolExecutionClient.calls.length, 0);
  assert.equal(result.isKnowledgeGap, true);
  assert.equal(result.gapReason, 'no_chunks_found');
});

test('gate-closed (emailLookupAvailable false): classifier says yes but Relativity says no connection -> tools never offered', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([{ document_id: 'doc-1', metadata: { fileName: 'PTO.pdf' } }]);
  const openaiService = createFakeOpenaiService({ intent: intentWithGate(true), ragAnswer: 'PTO answer' });
  const toolExecutionClient = createFakeToolExecutionClient();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Did Sarah reply about PTO?', memberId: MEMBER_ID,
    emailLookupAvailable: false, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(openaiService.calls.generateRagAnswer, 1);
  assert.equal(toolExecutionClient.calls.length, 0);
  assert.equal(result.answer, 'PTO answer');
});

test('gate-closed (no memberId): tools never offered even if both other signals are true', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([{ document_id: 'doc-1', metadata: { fileName: 'PTO.pdf' } }]);
  const openaiService = createFakeOpenaiService({ intent: intentWithGate(true) });
  const toolExecutionClient = createFakeToolExecutionClient();

  await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Search my email', memberId: null,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(openaiService.calls.generateRagAnswer, 1);
  assert.equal(toolExecutionClient.calls.length, 0);
});

test('gate-open, no call: the model answers directly from stored context; tools were offered but never invoked', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([{ document_id: 'doc-1', metadata: { fileName: 'PTO.pdf' } }]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [{ type: 'text', content: 'You get 15 days of PTO, per our handbook.' }],
  });
  const toolExecutionClient = createFakeToolExecutionClient();

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'What is our PTO policy?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(openaiService.calls.generateRagAnswerWithTools, 1);
  assert.equal(openaiService.calls.continueRagAnswerWithToolResult, 0);
  assert.equal(toolExecutionClient.calls.length, 0);
  assert.equal(result.answer, 'You get 15 days of PTO, per our handbook.');
  assert.deepEqual(result.sources, [{ fileName: 'PTO.pdf', documentId: 'doc-1' }]);
  assert.equal(result.isKnowledgeGap, false);
});

test('single tool call (search only): call 1 offers only search_email_messages; a text answer after the search result stops the loop at one Relativity call', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]); // live-only case, no stored chunks
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: { senderContains: 'sarah@acme.com' } },
      { type: 'text', content: 'Sarah replied this morning about the renewal.' },
    ],
  });
  const searchMatches = [{ messageId: 'm1', threadId: 't1', subject: 'Re: renewal', fromAddress: 'sarah@acme.com', date: '2026-07-30T00:00:00Z', snippet: 'x', deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/m1' }];
  const toolExecutionClient = createFakeToolExecutionClient({
    search_email_messages: { status: 'ok', matches: searchMatches, truncated: false },
  });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Did Sarah reply about the renewal?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(toolExecutionClient.calls.length, 1);
  assert.equal(toolExecutionClient.calls[0].toolName, 'search_email_messages');
  assert.equal(toolExecutionClient.calls[0].requestingMemberId, MEMBER_ID);
  // Call 1 is structurally offered ONLY search_email_messages.
  assert.deepEqual(openaiService.offeredToolsPerCall[0], ['search_email_messages']);
  assert.equal(result.answer, 'Sarah replied this morning about the renewal.');
  assert.deepEqual(result.sources, [{
    type: 'live_email_message', subject: 'Re: renewal', from: 'sarah@acme.com', receivedAt: '2026-07-30T00:00:00Z',
    mailboxOwnerMemberId: MEMBER_ID, providerMessageId: 'm1', providerThreadId: 't1',
    deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/m1', live: true,
  }]);
  assert.equal(result.isKnowledgeGap, false);
});

test('two-call search-then-fetch: call 2 offers only get_email_content for an id call 1 actually returned; exactly 2 Relativity calls total', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: {} },
      { type: 'tool_call', name: 'get_email_content', args: { messageId: 'm1' } },
      { type: 'text', content: 'The customer asked for a 10% discount on renewal.' },
    ],
  });
  const toolExecutionClient = createFakeToolExecutionClient({
    search_email_messages: { status: 'ok', matches: [{ messageId: 'm1', threadId: 't1', subject: 'Acme thread', fromAddress: 'a@acme.com', date: '2026-07-30T00:00:00Z', snippet: 'x' }], truncated: false },
    get_email_content: { status: 'ok', messages: [{ messageId: 'm1', threadId: 't1', subject: 'Acme thread', fromAddress: 'a@acme.com', date: '2026-07-30T00:00:00Z', body: 'full body', truncated: false, deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/m1' }] },
  });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'What exactly did the customer say in the latest Acme thread?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(toolExecutionClient.calls.length, 2);
  assert.equal(toolExecutionClient.calls[0].toolName, 'search_email_messages');
  assert.equal(toolExecutionClient.calls[1].toolName, 'get_email_content');
  // Call 2 is structurally offered ONLY get_email_content; the final call offers no tools at all.
  assert.deepEqual(openaiService.offeredToolsPerCall[1], ['get_email_content']);
  assert.deepEqual(openaiService.offeredToolsPerCall[2], []);
  assert.equal(result.answer, 'The customer asked for a 10% discount on renewal.');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].type, 'live_email_message');
  assert.equal(result.sources[0].providerMessageId, 'm1');
});

test('bound enforcement: a get_email_content request for an id search never returned is rejected locally, never reaches Relativity a second time', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: {} },
      { type: 'tool_call', name: 'get_email_content', args: { messageId: 'unrelated-id-the-model-hallucinated' } },
      { type: 'text', content: 'I could not find that specific message.' },
    ],
  });
  const toolExecutionClient = createFakeToolExecutionClient({
    search_email_messages: { status: 'ok', matches: [{ messageId: 'm1', threadId: 't1', subject: 'x', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', snippet: 'x' }], truncated: false },
  });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Fetch that other message', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  // Only the search call actually reached Relativity — the fetch for an
  // unknown id was rejected locally, per ADR-010 Conformance's "cannot call
  // get_email_content for an id it did not receive from Call 1."
  assert.equal(toolExecutionClient.calls.length, 1);
  assert.deepEqual(openaiService.receivedToolResults[1], { status: 'error', reason: 'validation_error' });
  assert.equal(result.sources.length, 0); // no successful content fetch -> no live source
  // No live source came through, so the final text's "could not find"
  // phrasing correctly falls back to ordinary knowledge-gap handling
  // (isKnowledgeGapAnswer/normalizeGapAnswerSource, unchanged from before EL5).
  assert.equal(result.isKnowledgeGap, true);
  assert.match(result.answer, /I could not find that specific message/);
});

test('hybrid source-merging: a stored-document source and a live-email source both appear in the same answer', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([{ document_id: 'doc-1', metadata: { fileName: 'AcmeNotes.pdf' } }]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: { subjectContains: 'Acme' } },
      { type: 'text', content: 'Per our notes and a recent email, the Acme renewal is on track.' },
    ],
  });
  const toolExecutionClient = createFakeToolExecutionClient({
    search_email_messages: { status: 'ok', matches: [{ messageId: 'm1', threadId: 't1', subject: 'Acme renewal', fromAddress: 'a@acme.com', date: '2026-07-30T00:00:00Z', snippet: 'x', deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/m1' }], truncated: false },
  });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'What\'s changed on the Acme renewal since our notes?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.some((s) => s.fileName === 'AcmeNotes.pdf'));
  assert.ok(result.sources.some((s) => s.type === 'live_email_message' && s.providerMessageId === 'm1'));
});

test('a live source suppresses knowledge-gap classification even if the final text uses gap-like phrasing', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: {} },
      { type: 'text', content: 'I could not find this in the knowledge base, but a live email from Sarah confirms it.' },
    ],
  });
  const toolExecutionClient = createFakeToolExecutionClient({
    search_email_messages: { status: 'ok', matches: [{ messageId: 'm1', threadId: 't1', subject: 'x', fromAddress: 'sarah@acme.com', date: '2026-07-30T00:00:00Z', snippet: 'x' }], truncated: false },
  });

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Did Sarah confirm the date?', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.equal(result.isKnowledgeGap, false);
  assert.equal(result.sources.length, 1);
});

test('a provider failure from Relativity (e.g. timeout) is fed back as a named error result, never thrown', async () => {
  const supabaseService = baseSupabaseServiceWithChunks([]);
  const openaiService = createScriptedToolOpenaiService({
    intent: intentWithGate(true),
    toolScript: [
      { type: 'tool_call', name: 'search_email_messages', args: {} },
      { type: 'text', content: 'I could not search your email right now — please try again.' },
    ],
  });
  const toolExecutionClient = { async executeTool() { throw new Error('network down'); } };

  const result = await runKnowledgeQuery({
    clientId: CLIENT_ID, question: 'Search my email for the contract', memberId: MEMBER_ID,
    emailLookupAvailable: true, deps: { supabaseService, openaiService, toolExecutionClient },
  });

  assert.deepEqual(openaiService.receivedToolResults[0], { status: 'error', reason: 'provider_timeout', message: 'network down' });
  assert.equal(result.answer, 'I could not search your email right now — please try again.');
});
