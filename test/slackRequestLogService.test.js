'use strict';

// Unit coverage for services/supabaseService.js#claimSlackRequest /
// #markSlackRequestDelivered / #markSlackRequestFailed (Backlog M13,
// revised — migrations/009_slack_request_log.sql). This table replaces the
// old "look up the chat session by idempotency_key" dedup mechanism now
// that Slack-originated questions never create a session (see
// runKnowledgeQuery.js's persistConversation: false) — it stores ONLY
// operational metadata (client_id, idempotency_key, origin, status,
// attempt_count, error_category, timestamps), never a question/answer.
//
// Follows the same fake-@supabase/supabase-js substitution pattern as
// test/redactChatSession.test.js and test/chatSessionOriginFilter.test.js,
// extended with insert()/unique-constraint-conflict support (mirroring
// Relativity's test/slackEventLogService.test.js fake) so the real
// claim-before-enqueue dedup logic is exercised, not just stubbed.

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
      insert(payload) { state.op = 'insert'; state.payload = payload; return b; },
      update(payload) { state.op = 'update'; state.payload = payload; return b; },
      select() { if (!state.op) state.op = 'select'; return b; },
      eq(col, val) { state.filters[col] = val; return b; },
      maybeSingle() { state.single = true; return b; },
      single() { state.single = true; return b; },
      then(resolve, reject) {
        try { resolve(execute()); } catch (err) { reject(err); }
      },
    };

    function matches(row) {
      return Object.entries(state.filters).every(([col, val]) => row[col] === val);
    }

    function execute() {
      const rows = store[table] || (store[table] = []);

      if (state.op === 'insert') {
        const conflict = rows.find((r) => r.idempotency_key === state.payload.idempotency_key);
        if (conflict) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        const row = {
          id: `row-${rows.length + 1}`,
          status: 'processing',
          attempt_count: 1,
          error_category: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...state.payload,
        };
        rows.push(row);
        return { data: row, error: null };
      }

      if (state.op === 'update') {
        const matched = rows.filter(matches);
        matched.forEach((r) => Object.assign(r, state.payload));
        return { data: state.single ? (matched[0] || null) : matched, error: null };
      }

      // select
      const matched = rows.filter(matches);
      return { data: state.single ? (matched[0] || null) : matched, error: null };
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
  delete require.cache[require.resolve('../services/supabaseService')];
  const supabaseService = require('../services/supabaseService');

  return {
    supabaseService,
    restore: () => {
      if (previous) require.cache[supabaseJsPath] = previous;
      else delete require.cache[supabaseJsPath];
      delete require.cache[require.resolve('../config')];
      delete require.cache[require.resolve('../services/supabaseService')];
    },
  };
}

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

test('the first claim for an idempotency_key inserts a processing row and returns claimed: true', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    const { claimed, row } = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    assert.equal(claimed, true);
    assert.equal(row.status, 'processing');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.client_id, CLIENT_ID);
    assert.equal(row.origin, 'slack');
  } finally {
    restore();
  }
});

test('a claimed row never carries a question/answer/content field — only operational metadata', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    const { row } = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    const allowedKeys = new Set(['id', 'client_id', 'idempotency_key', 'origin', 'status', 'attempt_count', 'error_category', 'created_at', 'updated_at']);
    for (const key of Object.keys(row)) {
      assert.ok(allowedKeys.has(key), `unexpected column on knowledge_slack_request_log: ${key}`);
    }
  } finally {
    restore();
  }
});

test('a second claim for the same idempotency_key is NOT claimed, bumps attempt_count, and never enqueues twice', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    const first = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    const second = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.row.id, first.row.id, 'the duplicate claim resolves to the same underlying row');
    assert.equal(second.row.attempt_count, 2, 'a retried claim bumps attempt_count for observability');
  } finally {
    restore();
  }
});

test('a different idempotency_key is never blocked by an unrelated claim', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    const a = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    const b = await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev002', origin: 'slack_dm' });

    assert.equal(a.claimed, true);
    assert.equal(b.claimed, true);
    assert.notEqual(a.row.id, b.row.id);
  } finally {
    restore();
  }
});

test('markSlackRequestDelivered transitions a claimed row to delivered', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    const updated = await supabaseService.markSlackRequestDelivered('slack:Ev001');
    assert.equal(updated.status, 'delivered');
  } finally {
    restore();
  }
});

test('markSlackRequestFailed transitions a claimed row to failed with a sanitized error_category only', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient({});
  try {
    await supabaseService.claimSlackRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', origin: 'slack' });
    const updated = await supabaseService.markSlackRequestFailed('slack:Ev001', 'AIKB_PROCESSING_FAILED');
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error_category, 'AIKB_PROCESSING_FAILED');
  } finally {
    restore();
  }
});
