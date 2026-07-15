'use strict';

require('dotenv').config();

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  supabase: {
    aikb: {
      url: require_env('AIKB_SUPABASE_URL'),
      serviceKey: require_env('AIKB_SUPABASE_SERVICE_KEY'),
    },
    global: {
      url: require_env('GLOBAL_SUPABASE_URL'),
      serviceKey: require_env('GLOBAL_SUPABASE_SERVICE_KEY'),
    },
  },
  openai: {
    apiKey: require_env('OPENAI_API_KEY'),
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  },
  inngest: {
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  storage: {
    bucket: process.env.AIKB_STORAGE_BUCKET || 'aikb-documents',
  },
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024), 10),
  apiKey: process.env.API_KEY,
  // Architecture Review Phase 4, Milestone 4 (§4.10) — the additive
  // HMAC-signed envelope shared with Relativity, scoped only to POST
  // /api/knowledge/ask (verified here) and POST
  // /api/integrations/slack/deliver (signed here, verified by Relativity).
  // Must match Relativity's SERVICE_REQUEST_SIGNING_SECRET exactly.
  serviceRequest: {
    signingSecret: process.env.SERVICE_REQUEST_SIGNING_SECRET,
  },
  // Relativity's base URL, used only to call back
  // POST /api/integrations/slack/deliver once a Slack-originated question
  // has an answer (services/relativityDeliverClient.js). AIKB never calls
  // any other Relativity route.
  relativity: {
    apiBaseUrl: process.env.RELATIVITY_API_BASE_URL,
    deliverTimeoutMs: parseInt(process.env.RELATIVITY_DELIVER_TIMEOUT_MS || '8000', 10),
  },
};

module.exports = config;
