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
const { deliverResult, ERROR_CODES } = require('../services/relativityDeliverClient');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function withFakeFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return fn().finally(() => { global.fetch = original; });
}

test('sends a signed envelope to the exact deliver URL and never includes a Slack token', async () => {
  let captured;
  await withFakeFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  }, async () => {
    const result = await deliverResult({
      clientId: CLIENT_ID,
      idempotencyKey: 'slack:Ev001',
      payload: { answer: 'You get 15 days of PTO.', sources: [], isKnowledgeGap: false, sessionId: 'session-1' },
    });
    assert.deepEqual(result, { delivered: true });
  });

  assert.equal(captured.url, 'https://relativity.example.internal/api/integrations/slack/deliver');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.clientId, CLIENT_ID);
  assert.equal(body.idempotencyKey, 'slack:Ev001');
  assert.ok(body.signature);
  assert.equal(JSON.stringify(body).includes('xoxb-'), false);
});

test('rejects on a non-ok HTTP response', async () => {
  await withFakeFetch(async () => ({ ok: false, status: 500 }), async () => {
    await assert.rejects(
      () => deliverResult({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev002', payload: { answer: 'x' } }),
      (err) => err.code === ERROR_CODES.HTTP_ERROR
    );
  });
});

test('rejects on a network-level fetch failure', async () => {
  await withFakeFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(
      () => deliverResult({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev003', payload: { answer: 'x' } }),
      (err) => err.code === ERROR_CODES.HTTP_ERROR
    );
  });
});

test('an error payload (AIKB processing failure) is still signed and delivered the same way', async () => {
  let captured;
  await withFakeFetch(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200 }; }, async () => {
    await deliverResult({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev004', payload: { error: true, errorCode: 'AIKB_PROCESSING_FAILED' } });
  });
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.payload.error, true);
  assert.equal(body.payload.errorCode, 'AIKB_PROCESSING_FAILED');
});
