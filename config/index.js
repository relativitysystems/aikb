'use strict';

require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// Like require_env, but only enforced when NODE_ENV=production. For values
// that are genuinely optional in local dev but load-bearing once deployed —
// missing any of these previously failed silently (a 500 on first request,
// or a callback that never fires) rather than at boot, which is how
// SLACK_SIGNING_SECRET went unset in production undetected until routes/
// slack.js's own request-time check started rejecting every request.
function require_env_in_production(key) {
  const val = process.env[key];
  if (nodeEnv === 'production' && !val) {
    throw new Error(`Missing required environment variable in production: ${key}`);
  }
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
    nodeEnv,
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
    eventKey: require_env_in_production('INNGEST_EVENT_KEY'),
    signingKey: require_env_in_production('INNGEST_SIGNING_KEY'),
    // Applied to every inngest.createFunction in inngest/functions.js — a
    // single shared retry policy rather than 4 independently-duplicated
    // literals.
    defaultRetries: parsePositiveInt('INNGEST_DEFAULT_RETRIES', process.env.INNGEST_DEFAULT_RETRIES, 3),
  },
  slack: {
    signingSecret: require_env_in_production('SLACK_SIGNING_SECRET'),
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
    signingSecret: require_env_in_production('SERVICE_REQUEST_SIGNING_SECRET'),
  },
  // Relativity's base URL. Called back for three routes: POST
  // /api/integrations/slack/deliver once a Slack-originated question has an
  // answer (services/relativityDeliverClient.js), POST
  // /api/integrations/email/sync/tick on a cron interval (services/
  // relativityTickClient.js, EMAIL_INGESTION.md §18.3), and, as of EL3, POST
  // /api/tools/execute for the read-only email-tool registry (services/
  // toolExecutionClient.js, LIVE_EMAIL_LOOKUP.md §1.1 step 7) — AIKB calls
  // no other Relativity route.
  relativity: {
    apiBaseUrl: require_env_in_production('RELATIVITY_API_BASE_URL'),
    deliverTimeoutMs: parseInt(process.env.RELATIVITY_DELIVER_TIMEOUT_MS || '8000', 10),
    // EM8 — separate timeout from deliverTimeoutMs since the tick call has
    // a different, unrelated caller (a cron function, not a Slack question
    // request) and may need independent tuning as the fan-out logic on the
    // Relativity side grows.
    tickTimeoutMs: parseInt(process.env.RELATIVITY_TICK_TIMEOUT_MS || '15000', 10),
    // EL3 — same reasoning as tickTimeoutMs above: a distinct call shape
    // (a per-question tool call, not a Slack answer or a cron tick) gets
    // its own tunable timeout. Matches deliverTimeoutMs's default since
    // both are synchronous, in-request-flow calls the user is waiting on.
    toolExecuteTimeoutMs: parseInt(process.env.RELATIVITY_TOOL_EXECUTE_TIMEOUT_MS || '8000', 10),
  },
  // EM8 (§18.3) — the automatic-sync scheduler's own cron cadence. Should
  // roughly match Relativity's EMAIL_SYNC_TICK_INTERVAL_MS (documented, not
  // enforced across the two repos/config systems).
  emailSync: {
    tickCronSchedule: process.env.EMAIL_SYNC_TICK_CRON_SCHEDULE || '*/20 * * * *',
  },
};

module.exports = config;
