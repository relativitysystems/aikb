'use strict';

// HTTP-level test for POST /api/knowledge/ingest, matching this repo's
// existing convention (test/knowledgeAskRoute.test.js): only paths that
// provably make no real Supabase/Inngest network call are exercised here —
// auth gating (requireApiKey, requireServiceRequest) and body validation,
// all of which resolve before any database or Inngest call.
//
// EM6 (Architecture/architecture/EMAIL_INGESTION.md §14.2) widened this
// route's sourceProvider allow-list from {'portal_upload'} to also accept
// 'gmail'/'microsoft', and added the optional collectionId/emailMetadata
// fields — this file covers exactly that widening, not the full ingest
// pipeline (which requires a real Supabase/Storage/Inngest environment and
// is exercised via test/triggerPortalIngest.js's manual-trigger convention).

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

function post(baseUrl, payload, secret = process.env.SERVICE_REQUEST_SIGNING_SECRET) {
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: `test:${Math.random()}`, payload, secret });
  return fetch(`${baseUrl}/api/knowledge/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
    body: JSON.stringify({ ...envelope, payload }),
  });
}

const BASE_FIELDS = { sourceFileId: 'msg-1', fileName: 'email.txt', mimeType: 'text/plain', storagePath: 'uploads/x/msg-1' };

test('POST /api/knowledge/ingest — auth gating and sourceProvider/emailMetadata validation', async (t) => {
  const { server, baseUrl } = await startServer(buildApp());
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('rejects a request with no x-api-key', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects an unsupported sourceProvider', async () => {
    const res = await post(baseUrl, { ...BASE_FIELDS, sourceProvider: 'dropbox' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Unsupported sourceProvider/);
  });

  await t.test('still rejects a request missing storagePath, for the default portal_upload provider', async () => {
    const { storagePath, ...rest } = BASE_FIELDS;
    const res = await post(baseUrl, rest);
    assert.equal(res.status, 400);
  });

  await t.test('rejects sourceProvider gmail with no emailMetadata', async () => {
    const res = await post(baseUrl, { ...BASE_FIELDS, sourceProvider: 'gmail' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /emailMetadata is required/);
  });

  await t.test('rejects sourceProvider microsoft with no emailMetadata', async () => {
    const res = await post(baseUrl, { ...BASE_FIELDS, sourceProvider: 'microsoft' });
    assert.equal(res.status, 400);
  });

  await t.test('rejects a request signed with the wrong service-request secret even with a valid x-api-key', async () => {
    const res = await post(baseUrl, { ...BASE_FIELDS, sourceProvider: 'gmail', emailMetadata: { provider: 'gmail' } }, 'wrong-secret');
    assert.equal(res.status, 401);
  });

  // Everything past this point (gmail/microsoft + emailMetadata present, or
  // plain portal_upload) passes validation and proceeds to
  // supabaseService.requireActiveClient — a real Supabase call this file's
  // stated convention deliberately does not exercise (see the header
  // comment and knowledgeAskRoute.test.js's equivalent boundary).
});
