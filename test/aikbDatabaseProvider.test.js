'use strict';

// Unit coverage for services/aikbDatabaseProvider.js (ADR-008, Architecture
// repo, decisions/ADR-008-CLIENT-AIKB-DATABASE-ROUTING.md). Follows the same
// fake-@supabase/supabase-js substitution pattern as
// test/redactChatSession.test.js / test/chatSessionOriginFilter.test.js /
// test/slackRequestLogService.test.js, extended here to count createClient
// calls so caching/reuse can be asserted directly, not just inferred.

process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

function fakeClientFactory() {
  let createClientCalls = 0;
  const createClient = (url, key) => {
    createClientCalls += 1;
    return { __fakeClient: true, url, key, from: () => ({}), storage: {}, rpc: () => ({}) };
  };
  return { createClient, getCallCount: () => createClientCalls };
}

function withFakeSupabaseJs(factory, fn) {
  const supabaseJsPath = require.resolve('@supabase/supabase-js');
  const configPath = require.resolve('../config');
  const providerPath = require.resolve('../services/aikbDatabaseProvider');
  const previous = require.cache[supabaseJsPath];

  require.cache[supabaseJsPath] = {
    id: supabaseJsPath,
    filename: supabaseJsPath,
    loaded: true,
    exports: { createClient: factory.createClient },
  };

  delete require.cache[configPath];
  delete require.cache[providerPath];

  try {
    return fn(require('../services/aikbDatabaseProvider'));
  } finally {
    if (previous) require.cache[supabaseJsPath] = previous;
    else delete require.cache[supabaseJsPath];
    delete require.cache[configPath];
    delete require.cache[providerPath];
  }
}

const CLIENT_A = '11111111-1111-1111-1111-111111111111';
const CLIENT_B = '22222222-2222-2222-2222-222222222222';

test('two different valid client IDs resolve to the same shared AIKB project today', async () => {
  const factory = fakeClientFactory();
  await withFakeSupabaseJs(factory, async ({ getAikbDatabase }) => {
    const a = await getAikbDatabase(CLIENT_A);
    const b = await getAikbDatabase(CLIENT_B);

    assert.equal(a.mode, 'shared');
    assert.equal(b.mode, 'shared');
    assert.equal(a.supabase, b.supabase, 'both clients must resolve to the exact same underlying Supabase client instance');
    assert.equal(a.storageBucket, b.storageBucket);
  });
});

test('the shared client is constructed once and reused across repeated calls (cached, not rebuilt per request)', async () => {
  const factory = fakeClientFactory();
  await withFakeSupabaseJs(factory, async ({ getAikbDatabase }) => {
    await getAikbDatabase(CLIENT_A);
    await getAikbDatabase(CLIENT_A);
    await getAikbDatabase(CLIENT_B);
    await getAikbDatabase(CLIENT_B);

    assert.equal(factory.getCallCount(), 1, 'createClient must be called exactly once regardless of how many times/clients getAikbDatabase is called');
  });
});

test('returns the current Storage bucket configuration alongside the client', async () => {
  const factory = fakeClientFactory();
  await withFakeSupabaseJs(factory, async ({ getAikbDatabase }) => {
    const result = await getAikbDatabase(CLIENT_A);
    assert.equal(typeof result.storageBucket, 'string');
    assert.ok(result.storageBucket.length > 0);
  });
});

test('a missing clientId fails closed', async () => {
  const factory = fakeClientFactory();
  await withFakeSupabaseJs(factory, async ({ getAikbDatabase }) => {
    await assert.rejects(() => getAikbDatabase(undefined), /non-empty clientId/);
    await assert.rejects(() => getAikbDatabase(null), /non-empty clientId/);
  });
});

test('an empty or malformed clientId fails closed', async () => {
  const factory = fakeClientFactory();
  await withFakeSupabaseJs(factory, async ({ getAikbDatabase }) => {
    await assert.rejects(() => getAikbDatabase(''), /non-empty clientId/);
    await assert.rejects(() => getAikbDatabase('   '), /non-empty clientId/);
    await assert.rejects(() => getAikbDatabase(42), /non-empty clientId/);
    await assert.rejects(() => getAikbDatabase({}), /non-empty clientId/);
  });
});

test('missing required AIKB Supabase configuration produces a clear error', () => {
  const configPath = require.resolve('../config');
  const providerPath = require.resolve('../services/aikbDatabaseProvider');
  const savedUrl = process.env.AIKB_SUPABASE_URL;
  // Set (not delete) to an empty string: config/index.js reloads dotenv on
  // every require, and dotenv only fills in keys that are entirely absent
  // from process.env — deleting the key would just have .env repopulate it
  // on the next require, silently defeating this test.
  process.env.AIKB_SUPABASE_URL = '';
  delete require.cache[configPath];
  delete require.cache[providerPath];

  try {
    assert.throws(
      () => require('../services/aikbDatabaseProvider'),
      /Missing required environment variable: AIKB_SUPABASE_URL/,
      'requiring the provider without AIKB_SUPABASE_URL configured must fail fast with a clear message, not a confusing downstream Supabase error'
    );
  } finally {
    process.env.AIKB_SUPABASE_URL = savedUrl;
    delete require.cache[configPath];
    delete require.cache[providerPath];
  }
});
