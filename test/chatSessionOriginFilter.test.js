'use strict';

// Backlog M13: unit coverage for services/supabaseService.js#listChatSessions
// and #getChatSession's origin filtering — DM conversations (origin:
// 'slack_dm') must never be exposed through any portal-accessible session
// read, while pre-Milestone-4 sessions (origin: null, predating the origin
// column) must remain visible. Follows the same fake-@supabase/supabase-js
// substitution pattern as test/redactChatSession.test.js, extended with
// .is()/.or()/.order() support to exercise the real query-building logic
// (not just HTTP auth gating).

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
    const state = { eqFilters: {}, isFilters: {}, orGroup: null, single: false };
    const b = {
      select() { return b; },
      eq(col, val) { state.eqFilters[col] = val; return b; },
      is(col, val) { state.isFilters[col] = val; return b; },
      or(expr) {
        state.orGroup = expr.split(',').map((clause) => {
          const [col, op, val] = clause.split('.');
          return { col, op, val };
        });
        return b;
      },
      order() { return b; },
      maybeSingle() { state.single = true; return b; },
      then(resolve, reject) {
        try { resolve(execute()); } catch (err) { reject(err); }
      },
    };

    function matchesEq(row) {
      return Object.entries(state.eqFilters).every(([col, val]) => row[col] === val);
    }
    function matchesIs(row) {
      return Object.entries(state.isFilters).every(([col, val]) => row[col] === val);
    }
    function matchesOr(row) {
      if (!state.orGroup) return true;
      return state.orGroup.some(({ col, op, val }) => {
        if (op === 'is') return val === 'null' ? (row[col] === null || row[col] === undefined) : row[col] === val;
        if (op === 'neq') return row[col] !== val;
        if (op === 'eq') return row[col] === val;
        return false;
      });
    }

    function execute() {
      const rows = store[table] || (store[table] = []);
      const matched = rows.filter((r) => matchesEq(r) && matchesIs(r) && matchesOr(r));
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
const PORTAL_SESSION_ID = '22222222-2222-2222-2222-222222222222';
const SLACK_CHANNEL_SESSION_ID = '33333333-3333-3333-3333-333333333333';
const SLACK_DM_SESSION_ID = '44444444-4444-4444-4444-444444444444';
const LEGACY_SESSION_ID = '55555555-5555-5555-5555-555555555555';

function seededStore() {
  return {
    knowledge_chat_sessions: [
      { id: PORTAL_SESSION_ID, client_id: CLIENT_ID, title: 'Portal question', origin: 'portal', member_id: null, deleted_at: null },
      { id: SLACK_CHANNEL_SESSION_ID, client_id: CLIENT_ID, title: 'Channel mention', origin: 'slack', member_id: null, deleted_at: null },
      { id: SLACK_DM_SESSION_ID, client_id: CLIENT_ID, title: 'DM question', origin: 'slack_dm', member_id: null, deleted_at: null },
      { id: LEGACY_SESSION_ID, client_id: CLIENT_ID, title: 'Pre-Milestone-4 session', origin: null, member_id: null, deleted_at: null },
    ],
  };
}

test('listChatSessions excludes slack_dm but keeps portal, slack, and null-origin (legacy) sessions', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(seededStore());
  try {
    const sessions = await supabaseService.listChatSessions(CLIENT_ID, null, true);
    const ids = sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, [LEGACY_SESSION_ID, PORTAL_SESSION_ID, SLACK_CHANNEL_SESSION_ID].sort());
  } finally {
    restore();
  }
});

test('getChatSession returns null for a slack_dm session regardless of isAdmin', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(seededStore());
  try {
    const asAdmin = await supabaseService.getChatSession(CLIENT_ID, SLACK_DM_SESSION_ID, null, true);
    assert.equal(asAdmin, null, 'a DM session must 404 even for an admin — no portal-side carve-out');

    const asMember = await supabaseService.getChatSession(CLIENT_ID, SLACK_DM_SESSION_ID, 'member-1', false);
    assert.equal(asMember, null);
  } finally {
    restore();
  }
});

test('getChatSession still returns portal, slack, and legacy (null-origin) sessions normally', async () => {
  const { supabaseService, restore } = loadSupabaseServiceWithFakeClient(seededStore());
  try {
    const portal = await supabaseService.getChatSession(CLIENT_ID, PORTAL_SESSION_ID, null, true);
    assert.equal(portal.id, PORTAL_SESSION_ID);

    const legacy = await supabaseService.getChatSession(CLIENT_ID, LEGACY_SESSION_ID, null, true);
    assert.equal(legacy.id, LEGACY_SESSION_ID, 'a session predating the origin column must not be accidentally hidden');
  } finally {
    restore();
  }
});
