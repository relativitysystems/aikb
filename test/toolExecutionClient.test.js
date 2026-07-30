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
const { executeTool, ERROR_CODES } = require('../services/toolExecutionClient');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function withFakeFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return fn().finally(() => { global.fetch = original; });
}

test('sends a signed envelope to the exact tool-execute URL, with toolName/args nested under payload', async () => {
  let captured;
  await withFakeFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ status: 'ok', toolName: 'noop', echoedArgs: { hello: 'world' } }) };
  }, async () => {
    const result = await executeTool({
      clientId: CLIENT_ID,
      idempotencyKey: 'tool-exec:test-1',
      toolName: 'noop',
      args: { hello: 'world' },
      requestingMemberId: 'member-1',
      origin: 'portal',
      originMetadata: { route: '/api/knowledge/query' },
    });
    assert.deepEqual(result, { status: 'ok', toolName: 'noop', echoedArgs: { hello: 'world' } });
  });

  assert.equal(captured.url, 'https://relativity.example.internal/api/tools/execute');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.clientId, CLIENT_ID);
  assert.equal(body.idempotencyKey, 'tool-exec:test-1');
  assert.ok(body.signature);
  assert.equal(body.payload.toolName, 'noop');
  assert.deepEqual(body.payload.args, { hello: 'world' });
  assert.equal(body.payload.requestingMemberId, 'member-1');
  assert.equal(body.payload.origin, 'portal');
  assert.deepEqual(body.payload.originMetadata, { route: '/api/knowledge/query' });
  // clientId lives only in the envelope, never duplicated into the payload.
  assert.equal(body.payload.clientId, undefined);
});

test('returns the response body unchanged — unlike relativityDeliverClient, the tool result IS the data the caller needs', async () => {
  await withFakeFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', reason: 'unknown_tool' }) }),
    async () => {
      const result = await executeTool({ clientId: CLIENT_ID, idempotencyKey: 'tool-exec:test-2', toolName: 'search_email_messages', args: {} });
      assert.deepEqual(result, { status: 'error', reason: 'unknown_tool' });
    }
  );
});

test('rejects on a non-ok HTTP response', async () => {
  await withFakeFetch(async () => ({ ok: false, status: 500 }), async () => {
    await assert.rejects(
      () => executeTool({ clientId: CLIENT_ID, idempotencyKey: 'tool-exec:test-3', toolName: 'noop', args: {} }),
      (err) => err.code === ERROR_CODES.HTTP_ERROR
    );
  });
});

test('rejects on a network-level fetch failure', async () => {
  await withFakeFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(
      () => executeTool({ clientId: CLIENT_ID, idempotencyKey: 'tool-exec:test-4', toolName: 'noop', args: {} }),
      (err) => err.code === ERROR_CODES.HTTP_ERROR
    );
  });
});

test('rejects on a timeout', async () => {
  await withFakeFetch(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  }, async () => {
    await assert.rejects(
      () => executeTool({ clientId: CLIENT_ID, idempotencyKey: 'tool-exec:test-5', toolName: 'noop', args: {} }),
      (err) => err.code === ERROR_CODES.TIMEOUT
    );
  });
});

test('rejects with NOT_CONFIGURED when RELATIVITY_API_BASE_URL is unset — never attempts a network call', async () => {
  const originalBaseUrl = process.env.RELATIVITY_API_BASE_URL;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/toolExecutionClient')];
  process.env.RELATIVITY_API_BASE_URL = '';
  try {
    const { executeTool: executeToolUnconfigured, ERROR_CODES: CODES } = require('../services/toolExecutionClient');
    let fetchWasCalled = false;
    await withFakeFetch(async () => { fetchWasCalled = true; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
      await assert.rejects(
        () => executeToolUnconfigured({ clientId: CLIENT_ID, idempotencyKey: 'tool-exec:test-6', toolName: 'noop', args: {} }),
        (err) => err.code === CODES.NOT_CONFIGURED
      );
    });
    assert.equal(fetchWasCalled, false);
  } finally {
    process.env.RELATIVITY_API_BASE_URL = originalBaseUrl;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/toolExecutionClient')];
  }
});
