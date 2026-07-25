'use strict';

process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.RELATIVITY_API_BASE_URL = process.env.RELATIVITY_API_BASE_URL || 'https://relativity.example.internal';
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTick, ERROR_CODES } = require('../services/relativityTickClient');

function withFakeFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return fn().finally(() => { global.fetch = original; });
}

test('sends a signed SYSTEM-scoped envelope to the exact tick URL, with no clientId anywhere in the body', async () => {
  let captured;
  await withFakeFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ processed: 3, succeeded: 2, failed: 1, connectionIds: ['a', 'b', 'c'] }) };
  }, async () => {
    const result = await callTick();
    assert.deepEqual(result, { processed: 3, succeeded: 2, failed: 1, connectionIds: ['a', 'b', 'c'] });
  });

  assert.equal(captured.url, 'https://relativity.example.internal/api/integrations/email/sync/tick');
  const body = JSON.parse(captured.opts.body);
  assert.equal('clientId' in body, false, 'the tick call must never carry a clientId — it is system-scoped by design');
  assert.ok(body.idempotencyKey.startsWith('email-sync-tick:'));
  assert.ok(body.signature);
  assert.ok(body.requestId);
});

test('rejects on a non-ok HTTP response', async () => {
  await withFakeFetch(async () => ({ ok: false, status: 500 }), async () => {
    await assert.rejects(() => callTick(), (err) => err.code === ERROR_CODES.HTTP_ERROR);
  });
});

test('rejects on a network-level fetch failure', async () => {
  await withFakeFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(() => callTick(), (err) => err.code === ERROR_CODES.HTTP_ERROR);
  });
});

test('rejects with TIMEOUT on an abort/timeout error', async () => {
  await withFakeFetch(async () => { const err = new Error('timed out'); err.name = 'TimeoutError'; throw err; }, async () => {
    await assert.rejects(() => callTick(), (err) => err.code === ERROR_CODES.TIMEOUT);
  });
});

test('two consecutive calls produce two distinct signatures (each has its own requestId, even if issued in the same millisecond)', async () => {
  const captures = [];
  await withFakeFetch(async (url, opts) => {
    captures.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ processed: 0, succeeded: 0, failed: 0, connectionIds: [] }) };
  }, async () => {
    await callTick();
    await callTick();
  });
  assert.notEqual(captures[0].requestId, captures[1].requestId);
  assert.notEqual(captures[0].signature, captures[1].signature);
});
