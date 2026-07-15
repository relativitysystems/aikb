'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runKnowledgeQuery } = require('../services/runKnowledgeQuery');

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
  let nextSessionId = 1;
  let nextMessageId = 1;

  return {
    calls: { createChatSession: 0, createChatMessage: 0 },
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
    _sessions: sessions,
    _messages: messages,
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

test('no chunks found returns a knowledge-gap result with gapReason no_chunks_found, and does not create a second gap record', async () => {
  const supabaseService = createFakeSupabaseService();
  const openaiService = createFakeOpenaiService();
  let gapCreated = false;
  supabaseService.createKnowledgeGap = async () => { gapCreated = true; };

  const result = await runKnowledgeQuery({ clientId: CLIENT_ID, question: 'What is the meaning of life?', origin: 'slack', originMetadata: { teamId: 'T1' }, idempotencyKey: 'slack:Ev001', deps: { supabaseService, openaiService } });

  assert.equal(result.isKnowledgeGap, true);
  assert.equal(result.gapReason, 'no_chunks_found');
  assert.equal(gapCreated, false, 'runKnowledgeQuery must never call createKnowledgeGap itself');
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
