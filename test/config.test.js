'use strict';

// Coverage for config/index.js's newly centralized operational values
// (hardcoded-values audit follow-up): OpenAI model selection, Inngest retry
// count, the knowledge API rate limiter, the Google Drive page size, and the
// Supabase pagination defaults. Each is asserted for (a) its pre-existing
// default when the env var is unset and (b) picking up an explicit override.
// Follows the require.cache-busting pattern already used by
// test/aikbDatabaseProvider.test.js since config/index.js is a singleton
// module re-evaluated from process.env on every require.

process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../config');

// The env vars this suite manipulates, so each test can save/restore them
// and never leak a value into another test or file.
const MANAGED_VARS = [
  'OPENAI_CHAT_MODEL',
  'OPENAI_LIGHTWEIGHT_MODEL',
  'INNGEST_DEFAULT_RETRIES',
  'KNOWLEDGE_API_RATE_LIMIT_WINDOW_MS',
  'KNOWLEDGE_API_RATE_LIMIT_MAX',
  'GOOGLE_DRIVE_PAGE_SIZE',
  'RECENT_INGESTION_JOBS_LIMIT',
  'RECENT_ACTIVITY_LIMIT',
  'CHAT_CONTEXT_MESSAGE_LIMIT',
  'KNOWLEDGE_GAPS_LIST_LIMIT',
];

// Loads a fresh config/index.js under the given env overrides (merged onto
// the current process.env), restoring every managed var to its prior value
// (or deleting it, if it was never set) once `fn` returns/throws. Values are
// set to '' rather than deleted to represent "unset" — config/index.js calls
// dotenv on every require, and dotenv only fills in keys entirely absent
// from process.env, so deleting one here would let a real .env file
// silently repopulate it and defeat the test (same gotcha documented in
// test/aikbDatabaseProvider.test.js).
function withConfig(envOverrides, fn) {
  const saved = {};
  for (const key of MANAGED_VARS) saved[key] = process.env[key];

  for (const key of MANAGED_VARS) process.env[key] = '';
  Object.assign(process.env, envOverrides);

  delete require.cache[configPath];
  try {
    return fn(require('../config'));
  } finally {
    for (const key of MANAGED_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[configPath];
  }
}

test('openai.chatModel and lightweightModel default when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.openai.chatModel, 'gpt-4.1');
    assert.equal(config.openai.lightweightModel, 'gpt-4o-mini');
  });
});

test('openai.chatModel and lightweightModel pick up env overrides', () => {
  withConfig({ OPENAI_CHAT_MODEL: 'gpt-5', OPENAI_LIGHTWEIGHT_MODEL: 'gpt-5-mini' }, (config) => {
    assert.equal(config.openai.chatModel, 'gpt-5');
    assert.equal(config.openai.lightweightModel, 'gpt-5-mini');
  });
});

test('inngest.defaultRetries defaults to 3 when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.inngest.defaultRetries, 3);
  });
});

test('inngest.defaultRetries picks up an env override', () => {
  withConfig({ INNGEST_DEFAULT_RETRIES: '5' }, (config) => {
    assert.equal(config.inngest.defaultRetries, 5);
  });
});

test('inngest.defaultRetries rejects a non-positive-integer override', () => {
  assert.throws(
    () => withConfig({ INNGEST_DEFAULT_RETRIES: 'abc' }, (config) => config),
    /Invalid INNGEST_DEFAULT_RETRIES/
  );
  assert.throws(
    () => withConfig({ INNGEST_DEFAULT_RETRIES: '0' }, (config) => config),
    /Invalid INNGEST_DEFAULT_RETRIES/
  );
  assert.throws(
    () => withConfig({ INNGEST_DEFAULT_RETRIES: '-1' }, (config) => config),
    /Invalid INNGEST_DEFAULT_RETRIES/
  );
});

test('rateLimit.knowledgeApi defaults to a 15-minute window and a cap of 2000 when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.rateLimit.knowledgeApi.windowMs, 15 * 60 * 1000);
    assert.equal(config.rateLimit.knowledgeApi.max, 2000);
  });
});

test('rateLimit.knowledgeApi picks up env overrides', () => {
  withConfig({ KNOWLEDGE_API_RATE_LIMIT_WINDOW_MS: '60000', KNOWLEDGE_API_RATE_LIMIT_MAX: '100' }, (config) => {
    assert.equal(config.rateLimit.knowledgeApi.windowMs, 60000);
    assert.equal(config.rateLimit.knowledgeApi.max, 100);
  });
});

test('googleDrive.pageSize defaults to 200 when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.googleDrive.pageSize, 200);
  });
});

test('googleDrive.pageSize picks up an env override', () => {
  withConfig({ GOOGLE_DRIVE_PAGE_SIZE: '50' }, (config) => {
    assert.equal(config.googleDrive.pageSize, 50);
  });
});

test('pagination defaults match the pre-existing literals when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.pagination.recentIngestionJobsLimit, 100);
    assert.equal(config.pagination.recentActivityLimit, 10);
    assert.equal(config.pagination.chatContextMessageLimit, 8);
    assert.equal(config.pagination.knowledgeGapsListLimit, 200);
  });
});

test('pagination values pick up env overrides independently', () => {
  withConfig({
    RECENT_INGESTION_JOBS_LIMIT: '250',
    RECENT_ACTIVITY_LIMIT: '25',
    CHAT_CONTEXT_MESSAGE_LIMIT: '12',
    KNOWLEDGE_GAPS_LIST_LIMIT: '500',
  }, (config) => {
    assert.equal(config.pagination.recentIngestionJobsLimit, 250);
    assert.equal(config.pagination.recentActivityLimit, 25);
    assert.equal(config.pagination.chatContextMessageLimit, 12);
    assert.equal(config.pagination.knowledgeGapsListLimit, 500);
  });
});

test('a non-positive-integer pagination override fails clearly rather than silently coercing', () => {
  assert.throws(
    () => withConfig({ RECENT_ACTIVITY_LIMIT: 'not-a-number' }, (config) => config),
    /Invalid RECENT_ACTIVITY_LIMIT: must be a positive integer/
  );
  assert.throws(
    () => withConfig({ CHAT_CONTEXT_MESSAGE_LIMIT: '3.5' }, (config) => config),
    /Invalid CHAT_CONTEXT_MESSAGE_LIMIT/
  );
});
