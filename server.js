'use strict';

const express = require('express');
const { serve } = require('inngest/express');
const config = require('./config');
const { inngest } = require('./inngest/client');
const { functions } = require('./inngest/functions');
const knowledgeRoutes = require('./routes/knowledge');
const slackRoutes = require('./routes/slack');

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'relativity-knowledge-base' }));

// Inngest serve endpoint — must come before other routes
app.use('/api/inngest', serve({ client: inngest, functions }));

app.use('/api/knowledge', knowledgeRoutes);
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
