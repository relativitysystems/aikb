'use strict';

const express = require('express');
const { serve } = require('inngest/express');
const config = require('./config');
const { inngest } = require('./inngest/client');
const { functions } = require('./inngest/functions');
const knowledgeRoutes = require('./routes/knowledge');
const slackRoutes = require('./routes/slack');
const corsPolicy = require('./middleware/corsPolicy');
const { knowledgeApiLimiter } = require('./middleware/rateLimit');

const app = express();

// Backlog M6 — explicit CORS policy, ahead of every route.
app.use(corsPolicy);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'relativity-knowledge-base' }));

// Inngest serve endpoint — must come before other routes
app.use('/api/inngest', serve({ client: inngest, functions }));

// Backlog M6 — general-purpose rate limiting on every x-api-key-gated route.
app.use('/api/knowledge', knowledgeApiLimiter, knowledgeRoutes);
app.use('/api/slack', slackRoutes);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const isProd = config.server.nodeEnv === 'production';
  if (isProd && status >= 500) {
    console.error('[server error]', err);
  }
  const message = (isProd && status >= 500) ? 'An unexpected error occurred.' : err.message;
  const body = { error: message };
  if (!isProd) body.stack = err.stack;
  res.status(status).json(body);
});

app.listen(config.server.port, () => {
  console.log(`[relativity-knowledge-base] listening on port ${config.server.port}`);
});
