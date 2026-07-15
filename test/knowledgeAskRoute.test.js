'use strict';

// HTTP-level test for POST /api/knowledge/ask, matching this repo's existing
// convention (test/slackEventsRetired.test.js): only paths that provably
// make no real Supabase/Inngest network call are exercised here — auth
// gating (requireApiKey, requireServiceRequest) and body validation, which
// all resolve before any database or Inngest call. Deeper pipeline coverage
// (the shared RAG logic itself, including origin: 'slack' behavior) lives
// in test/runKnowledgeQuery.test.js, which tests the extracted function
// directly via dependency injection.

process.env.API_KEY = process.env.API_KEY || 'test-api-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const knowledgeRoutes = require('../routes/knowledge');
const { signServiceRequest } = require('../services/serviceRequestAuth');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge', knowledgeRoutes);
  return app;
}

async function startServer(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('POST /api/knowledge/ask — auth gating and validation', async (t) => {
  const { server, baseUrl } = await startServer(buildApp());
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('rejects a request with no x-api-key', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request with a valid x-api-key but no service-request envelope', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ payload: { question: 'x' } }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request with a valid envelope but no question in the payload', async () => {
    const payload = { origin: 'slack' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', payload, secret: process.env.SERVICE_REQUEST_SIGNING_SECRET });

    const res = await fetch(`${baseUrl}/api/knowledge/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ ...envelope, payload }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('rejects a request signed with the wrong service-request secret even with a valid x-api-key', async () => {
    const payload = { question: 'What is our PTO policy?', origin: 'slack' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev002', payload, secret: 'wrong-secret' });

    const res = await fetch(`${baseUrl}/api/knowledge/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ ...envelope, payload }),
    });
    assert.equal(res.status, 401);
  });
});

