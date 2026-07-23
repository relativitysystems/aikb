'use strict';

// Unit coverage for services/supabaseService.js#redactChatSessionByIdempotencyKey
// (ADR-007, decisions/ADR-007-SLACK-BOUNDED-DELIVERY-RETRY.md in the
// Architecture repo). supabaseService.js talks to a real @supabase/supabase-js
// client constructed at module load time (no DI factory, unlike
// services/runKnowledgeQuery.js) — this file substitutes a minimal in-memory
// fake for '@supabase/supabase-js' in the require cache before loading
// supabaseService.js fresh, so the redaction logic itself (not just HTTP
// auth gating, covered separately in test/knowledgeRedactRoute.test.js) is
// exercised against real update/select semantics.

process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeSupabaseClient(store) {
  function builder(table) {
    const state = { filters: {}, op: null, payload: null, single: false };
    const b = {
      select() { if (!state.op) state.op = 'select'; return b; },
      update(payload) { state.op = 'update'; state.payload = payload; return b; },
      eq(col, val) { state.filters[col] = val; return b; },
      maybeSingle() { state.single = true; return b; },
      then(resolve, reject) {
        try { resolve(execute()); } catch (err) { reject(err); }
      },
    };

    function matches(row) {
      return Object.entries(state.filters).every(([col, val]) => row[col] === val);
    }

    function execute() {
      const rows = store[table] || (store[table] = []);
      const matched = rows.filter(matches);
      if (state.op === 'update') {
        matched.forEach((r) => Object.assign(r, state.payload));
        return { data: matched, error: null };
      }
      if (state.single) return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }

    return b;
  }

  return { from: builder };
}

function loadSupabaseServiceWithFakeClient(store) {
  const supabaseJsPath = require.resolve('@supabase/supabase-js');
  const previous = require.cache[supabaseJsPath];

  require.cache[supabaseJsPath] = {
    id: supabaseJsPath,
    filename: supabaseJsPath,
    loaded: true,
    exports: { createClient: () => makeFakeSupabaseClient(store) },
  };

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/aikbDatabaseProvider')];
  delete require.cache[require.resolve('../services/supabaseService')];
  const supabaseService = require('../services/supabaseService');

  return {
    supabaseService,
    restore: () => {
      if (previous) require.cache[supabaseJsPath] = previous;
      else delete require.cache[supabaseJsPath];
      delete require.cache[require.resolve('../config')];
      delete require.cache[require.resolve('../services/aikbDatabaseProvider')];
      delete require.cache[require.resolve('../services/supabaseService')];
    },
  };
}

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-3333-3333-333333333333';
const IDEMPOTENCY_KEY = 'slack:Ev001';

function seededStore() {
  return {
    knowledge_chat_sessions: [
      {
        id: SESSION_ID,
        client_id: CLIENT_ID,
        title: 'What is our PTO policy?',
        origin: 'slack',
        origin_metadata: { teamId: 'T1', channelId: 'C1', threadTs: '1.0', eventId: 'Ev001' },
        idempotency_key: IDEMPOTENCY_KEY,
        deleted_at: null,
      },
      {
        id: OTHER_SESSION_ID,
        client_id: CLIENT_ID,
        title: 'A different, unrelated session',
        origin: 'portal',
        origin_metadata: null,
        idempotency_key: null,
        deleted_at: null,
      },
    ],
    knowledge_chat_messages: [
      { id: 'm1', client_id: CLIENT_ID, session_id: SESSION_ID, role: 'user', content: 'What is our PTO policy?', sources: null, metadata: null },
      {
        id: 'm2', client_id: CLIENT_ID, session_id: SESSION_ID, role: 'assistant', content: 'You get 15 days of PTO.',
        sources: [{ fileName: 'PTO.pdf' }],
        metadata: { question: 'What is our PTO policy?', retrievalQuery: 'PTO policy days', chunkCount: 2, documentIds: ['doc-1'] },
      },
      { id: 'm3', client_id: CLIENT_ID, session_id: OTHER_SESSION_ID, role: 'user', content: 'Unrelated question', sources: null, metadata: null },
    ],
  };
}

test('redacts the question, answer, sources, and prompt/retrieval metadata for the matching session only', async () => {
  const store = seededStore();
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(store);

  try {
    const result = await supabaseService.redactChatSessionByIdempotencyKey(CLIENT_ID, IDEMPOTENCY_KEY);
    assert.equal(result.redacted, true);
    assert.equal(result.sessionId, SESSION_ID);

    const session = store.knowledge_chat_sessions.find((s) => s.id === SESSION_ID);
    assert.equal(session.title, null, 'the session title (derived from the question) must be redacted');
    // Technical/dedup metadata must survive redaction.
    assert.equal(session.idempotency_key, IDEMPOTENCY_KEY);
    assert.deepEqual(session.origin_metadata, { teamId: 'T1', channelId: 'C1', threadTs: '1.0', eventId: 'Ev001' });

    const userMsg = store.knowledge_chat_messages.find((m) => m.id === 'm1');
    const assistantMsg = store.knowledge_chat_messages.find((m) => m.id === 'm2');

    assert.equal(userMsg.content, '[redacted — Slack delivery failed, see ADR-007]');
    assert.equal(assistantMsg.content, '[redacted — Slack delivery failed, see ADR-007]', 'the generated answer must be redacted');
    assert.equal(assistantMsg.sources, null, 'retrieved-document citations must be redacted');
    assert.equal(assistantMsg.metadata, null, 'prompt/retrieval metadata (question, retrievalQuery, documentIds) must be redacted');

    // A different client's/session's messages must never be touched.
    const unrelatedMsg = store.knowledge_chat_messages.find((m) => m.id === 'm3');
    assert.equal(unrelatedMsg.content, 'Unrelated question');
    const unrelatedSession = store.knowledge_chat_sessions.find((s) => s.id === OTHER_SESSION_ID);
    assert.equal(unrelatedSession.title, 'A different, unrelated session');
  } finally {
    restore();
  }
});

test('is idempotent — redacting twice is a safe no-op the second time too', async () => {
  const store = seededStore();
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(store);

  try {
    await supabaseService.redactChatSessionByIdempotencyKey(CLIENT_ID, IDEMPOTENCY_KEY);
    const second = await supabaseService.redactChatSessionByIdempotencyKey(CLIENT_ID, IDEMPOTENCY_KEY);
    assert.equal(second.redacted, true);
  } finally {
    restore();
  }
});

test('an unknown idempotencyKey (no session ever created, e.g. AIKB was never reached) is a safe no-op', async () => {
  const store = seededStore();
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(store);

  try {
    const result = await supabaseService.redactChatSessionByIdempotencyKey(CLIENT_ID, 'slack:never-existed');
    assert.deepEqual(result, { redacted: false, reason: 'not_found' });
  } finally {
    restore();
  }
});
