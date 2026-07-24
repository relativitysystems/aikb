'use strict';

require('dotenv').config();

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// Parses an optional positive-integer env var, falling back to defaultValue
// when unset/empty. Fails fast and clearly (rather than silently coercing to
// NaN) if the value is set but not a valid positive integer.
function parsePositiveInt(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === '') return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer, got "${rawValue}"`);
  }
  return parsed;
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
    // Full RAG answers / general chat completions (services/openaiService.js
    // generateRagAnswer/generateChatCompletion). Distinct from lightweightModel
    // below — this one sees the full retrieved context.
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4.1',
    // Cheaper/faster model for the intent classifier and retrieval query
    // rewriter (services/openaiService.js classifyQueryIntent/buildRetrievalQuery)
    // — small, structured-output calls that don't need the full chat model.
    lightweightModel: process.env.OPENAI_LIGHTWEIGHT_MODEL || 'gpt-4o-mini',
  },
  inngest: {
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    // Applied to every inngest.createFunction in inngest/functions.js — a
    // single shared retry policy rather than 4 independently-duplicated
    // literals.
    defaultRetries: parsePositiveInt('INNGEST_DEFAULT_RETRIES', process.env.INNGEST_DEFAULT_RETRIES, 3),
  },
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  storage: {
    bucket: process.env.AIKB_STORAGE_BUCKET || 'aikb-documents',
  },
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024), 10),
  apiKey: process.env.API_KEY,
  // Backlog M6 — defense-in-depth rate limit across all of /api/knowledge
  // (middleware/rateLimit.js). Generous by design: Relativity is this API's
  // only expected caller, so this guards against a leaked key or a runaway
  // retry loop, not per-tenant quota enforcement.
  rateLimit: {
    knowledgeApi: {
      windowMs: parsePositiveInt('KNOWLEDGE_API_RATE_LIMIT_WINDOW_MS', process.env.KNOWLEDGE_API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: parsePositiveInt('KNOWLEDGE_API_RATE_LIMIT_MAX', process.env.KNOWLEDGE_API_RATE_LIMIT_MAX, 2000),
    },
  },
  // services/googleDriveService.js — currently unreferenced by any route or
  // Inngest function (Google Drive sync was removed; see .env.example), kept
  // for possible future use. pageSize only, since serviceAccountEmail/
  // privateKey were intentionally retired and are not reintroduced here.
  googleDrive: {
    pageSize: parsePositiveInt('GOOGLE_DRIVE_PAGE_SIZE', process.env.GOOGLE_DRIVE_PAGE_SIZE, 200),
  },
  // Result-set caps for admin/analytics-style reads (services/supabaseService.js).
  // Tuning these trades off dashboard completeness against query cost as
  // per-client data volume grows.
  pagination: {
    // fetchRecentIngestionJobs' default window for the client stats/health
    // endpoints (getClientAnalyticsData, getClientKnowledgeStats, getIngestionJobsByClient).
    recentIngestionJobsLimit: parsePositiveInt('RECENT_INGESTION_JOBS_LIMIT', process.env.RECENT_INGESTION_JOBS_LIMIT, 100),
    // "Recent" slice shown in analytics/stats responses (recent knowledge
    // gaps, recent failed jobs, recent ingestion activity).
    recentActivityLimit: parsePositiveInt('RECENT_ACTIVITY_LIMIT', process.env.RECENT_ACTIVITY_LIMIT, 10),
    // listRecentChatMessages' default window of prior messages fed to the
    // intent classifier/retrieval query rewriter as conversation context.
    chatContextMessageLimit: parsePositiveInt('CHAT_CONTEXT_MESSAGE_LIMIT', process.env.CHAT_CONTEXT_MESSAGE_LIMIT, 8),
    // listKnowledgeGapsByClient's row cap for the admin gaps list.
    knowledgeGapsListLimit: parsePositiveInt('KNOWLEDGE_GAPS_LIST_LIMIT', process.env.KNOWLEDGE_GAPS_LIST_LIMIT, 200),
  },
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
