'use strict';

process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requireServiceRequest } = require('../middleware/serviceRequest');
const { signServiceRequest } = require('../services/serviceRequestAuth');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/protected', requireServiceRequest, (req, res) => {
    res.json({ ok: true, clientId: req.serviceRequest.clientId, idempotencyKey: req.serviceRequest.idempotencyKey });
  });
  return app;
}

async function startServer(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('requireServiceRequest middleware', async (t) => {
  const { server, baseUrl } = await startServer(buildApp());
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('accepts a validly signed envelope and exposes clientId/idempotencyKey', async () => {
    const payload = { question: 'x', origin: 'slack' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001', payload, secret: process.env.SERVICE_REQUEST_SIGNING_SECRET });

    const res = await fetch(`${baseUrl}/protected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.clientId, CLIENT_ID);
    assert.equal(body.idempotencyKey, 'slack:Ev001');
  });

  await t.test('rejects a request with no envelope at all', async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { question: 'x' } }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request with a tampered payload', async () => {
    const payload = { question: 'original' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev002', payload, secret: process.env.SERVICE_REQUEST_SIGNING_SECRET });

    const res = await fetch(`${baseUrl}/protected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload: { question: 'tampered' } }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request signed with the wrong secret', async () => {
    const payload = { question: 'x' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev003', payload, secret: 'wrong-secret' });

    const res = await fetch(`${baseUrl}/protected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('never trusts a clientId supplied outside the signed envelope', async () => {
    const payload = { question: 'x' };
    const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev004', payload, secret: process.env.SERVICE_REQUEST_SIGNING_SECRET });
    // Spoofed top-level clientId different from the signed envelope's — the
    // signature covers clientId itself, so tampering it invalidates the sig.
    const res = await fetch(`${baseUrl}/protected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, clientId: 'attacker-supplied-client-id', payload }),
    });
    assert.equal(res.status, 401);
  });
});
