'use strict';

// Behavior tests for the retired POST /api/slack/events endpoint
// (Architecture Review Phase 4, Milestone 1 — chore/disable-legacy-slack).
//
// Sets SLACK_SIGNING_SECRET/NODE_ENV before requiring any module under test
// so signature verification runs for real in this process, regardless of
// whatever the local .env file does or doesn't set.
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret-for-slack-retirement-tests';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const slackRoutes = require('../routes/slack');
const slackRouteSource = fs.readFileSync(require.resolve('../routes/slack'), 'utf8');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/slack', slackRoutes);
  return app;
}

function sign(timestamp, rawBody) {
  const hmac = crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  return `v0=${hmac}`;
}

async function startServer(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function postSlackEvent(baseUrl, bodyObj, { validSignature = true, timestampOffsetSeconds = 0 } = {}) {
  const rawBody = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000) - timestampOffsetSeconds;
  const signature = validSignature ? sign(timestamp, rawBody) : `v0=${'0'.repeat(64)}`;

  const res = await fetch(`${baseUrl}/api/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(timestamp),
      'X-Slack-Signature': signature,
    },
    body: rawBody,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('a correctly signed url_verification request returns the challenge', async () => {
  const { server, baseUrl } = await startServer(buildApp());
  try {
    const { status, json } = await postSlackEvent(baseUrl, {
      type: 'url_verification',
      challenge: 'abc123',
    });
    assert.equal(status, 200);
    assert.equal(json.challenge, 'abc123');
  } finally {
    server.close();
  }
});

test('an invalidly signed url_verification request is rejected before any challenge is returned', async () => {
  const { server, baseUrl } = await startServer(buildApp());
  try {
    const { status, json } = await postSlackEvent(
      baseUrl,
      { type: 'url_verification', challenge: 'abc123' },
      { validSignature: false }
    );
    assert.equal(status, 401);
    assert.equal(json.challenge, undefined);
  } finally {
    server.close();
  }
});

test('a replayed (stale timestamp) request is rejected regardless of signature correctness', async () => {
  const { server, baseUrl } = await startServer(buildApp());
  try {
    const { status } = await postSlackEvent(
      baseUrl,
      { type: 'url_verification', challenge: 'abc123' },
      { timestampOffsetSeconds: 600 } // 10 minutes old, outside the 5-minute window
    );
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});

test('a validly signed app_mention event_callback returns exactly the 410 retirement body', async () => {
  const { server, baseUrl } = await startServer(buildApp());
  try {
    const { status, json } = await postSlackEvent(baseUrl, {
      type: 'event_callback',
      team_id: 'T12345',
      event_id: 'Ev999',
      event: {
        type: 'app_mention',
        channel: 'C123',
        ts: '123.456',
        text: '<@BOT123> what is our PTO policy?',
      },
    });
    assert.equal(status, 410);
    assert.deepEqual(json, { error: 'This Slack integration endpoint has been retired.' });
  } finally {
    server.close();
  }
});

test('a validly signed event_callback never reaches Slack\'s Web API or any other outbound HTTP call', async () => {
  // The only outbound call the legacy handler ever made was a raw global
  // fetch() to slack.com/api/chat.postMessage. Spy on global fetch to prove
  // no such call happens, while still allowing this test's own request to
  // the local ephemeral server through.
  const realFetch = global.fetch;
  const externalCalls = [];
  global.fetch = async (url, ...args) => {
    const urlString = typeof url === 'string' ? url : url.toString();
    if (!urlString.includes('127.0.0.1') && !urlString.includes('localhost')) {
      externalCalls.push(urlString);
    }
    return realFetch(url, ...args);
  };

  const { server, baseUrl } = await startServer(buildApp());
  try {
    await postSlackEvent(baseUrl, {
      type: 'event_callback',
      team_id: 'T12345',
      event: { type: 'app_mention', channel: 'C123', ts: '1.1', text: '<@BOT> hello' },
    });
    assert.deepEqual(externalCalls, [], 'no outbound HTTP call (e.g. Slack chat.postMessage) should occur');
  } finally {
    server.close();
    global.fetch = realFetch;
  }
});

test('the route module no longer imports supabaseService or openaiService (retrieval/answer-generation is structurally impossible)', () => {
  assert.ok(!slackRouteSource.includes("require('../services/supabaseService')"),
    'supabaseService must not be imported — no document retrieval capability should remain');
  assert.ok(!slackRouteSource.includes("require('../services/openaiService')"),
    'openaiService must not be imported — no answer-generation capability should remain');
});

test('the module no longer contains or exports slackChannelToClientId', () => {
  assert.equal(typeof slackRoutes.slackChannelToClientId, 'undefined');
  assert.ok(!slackRouteSource.includes('slackChannelToClientId'));
});

test('the module no longer reads a global Slack bot token or posts to Slack', () => {
  assert.ok(!slackRouteSource.includes('botToken'));
  assert.ok(!slackRouteSource.includes('postSlackMessage'));
  assert.ok(!slackRouteSource.includes('SLACK_BOT_TOKEN'));
});
