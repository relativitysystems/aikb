'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------
// Slack request signature verification middleware
//
// Kept fully intact — signature verification and replay-window protection
// remain required even though this endpoint is retired below. An unsigned
// or forged request must never reach the retirement response.
// ---------------------------------------------------------------------------

function verifySlackSignature(req, res, next) {
  if (!config.slack.signingSecret) {
    // No signing secret configured — skip verification in dev
    if (config.server.nodeEnv === 'production') {
      return res.status(500).json({ error: 'SLACK_SIGNING_SECRET is not configured' });
    }
    return next();
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];

  if (!timestamp || !slackSig) {
    return res.status(400).json({ error: 'Missing Slack signature headers' });
  }

  // Reject requests older than 5 minutes (replay attack protection)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return res.status(400).json({ error: 'Request timestamp too old' });
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac('sha256', config.slack.signingSecret)
    .update(sigBase)
    .digest('hex');
  const expected = `v0=${hmac}`;

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSig))) {
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  next();
}

// ---------------------------------------------------------------------------
// Logging helpers
//
// Only enough to notice that a real Slack app is still pointed at this
// retired endpoint. Never logs message text, questions, tokens, secrets,
// or the raw request body.
// ---------------------------------------------------------------------------

function hashTeamId(teamId) {
  if (!teamId) return null;
  return crypto.createHash('sha256').update(String(teamId)).digest('hex').slice(0, 12);
}

function logRetiredEventCallback(req) {
  const body = req.body || {};
  const eventType = (body.event && body.event.type) || body.type || 'unknown';
  const requestId = req.headers['x-request-id'] || body.event_id || null;

  console.warn('[slack] retired endpoint received an event — no processing performed', {
    eventType,
    teamIdHash: hashTeamId(body.team_id),
    requestId,
  });
}

// ---------------------------------------------------------------------------
// POST /api/slack/events
//
// RETIRED. This provider-specific handler previously derived a fake tenant
// from a hash of the Slack channel ID and posted replies using a single
// static global bot token — both unsafe (Architecture Review Phase 1 §6/§9,
// Phase 4 Milestone 1). The safe replacement lives in Relativity's Slack
// Surface. Until that ships, this route stays mounted (so Slack's app
// config doesn't 404 unexpectedly) but performs no document retrieval, no
// answer generation, no client/organization derivation, and no Slack
// posting for any event.
//
// url_verification is still answered normally — it carries no tenant data
// and Slack uses it purely to confirm the endpoint is reachable — but only
// after signature verification succeeds, same as before.
// ---------------------------------------------------------------------------

router.post('/events', verifySlackSignature, (req, res) => {
  const { type, challenge } = req.body || {};

  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  logRetiredEventCallback(req);

  return res.status(410).json({
    error: 'This Slack integration endpoint has been retired.',
  });
});

module.exports = router;
