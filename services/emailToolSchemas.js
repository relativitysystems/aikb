'use strict';

// Read-only email tool registry (EL2 — Architecture/architecture/LIVE_EMAIL_LOOKUP.md
// §4, ADR-010). This module defines the two tools' OpenAI-shaped `tools`
// array entries as plain, directly-testable data — nothing here is wired
// into openaiService.js/runKnowledgeQuery.js yet (that's EL5), and nothing
// here calls Gmail, resolves a connection, or performs authorization (EL3/
// EL4). Landing the schema before any execution code mirrors
// EMAIL_INGESTION.md's own EM1 precedent ("land the schema, wire nothing
// yet").
//
// The exact `parameters` shape below must stay in sync, field for field,
// with Relativity/services/emailToolValidation.js — that file validates
// incoming tool-call arguments against the same fields before Relativity
// ever calls Gmail. There is no shared package between the two repos, so
// this is kept honest the same way services/serviceRequestAuth.js's
// signing-string format already is: a fixture test in each repo asserting
// the same hardcoded shape (see test/emailToolSchemas.test.js here and
// Relativity/test/emailToolValidation.test.js), reviewed side by side
// rather than cross-checked at runtime.
//
// Consolidated per §4.1's "two tools, not nine" — every other candidate
// tool the task originally listed is a parameterization of one of these
// two, never a separate tool.

const TOOL_NAMES = Object.freeze({
  SEARCH_EMAIL_MESSAGES: 'search_email_messages',
  GET_EMAIL_CONTENT: 'get_email_content',
});

// §4.2 — find candidate messages matching structured criteria; returns
// metadata + a short snippet, never a full body. Hard caps (maxResults:
// default 10, hard cap 25) are documented here for the model but enforced
// server-side in Relativity (config.email.liveLookup), never trusted from
// the model's own request.
const SEARCH_EMAIL_MESSAGES_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.SEARCH_EMAIL_MESSAGES,
    description:
      'Search the requesting member\'s own connected mailbox for messages matching structured criteria. ' +
      'Returns message metadata and a short snippet only — never the full message body (use get_email_content ' +
      'for that). All fields are optional; omitting every field returns the most recent messages.',
    parameters: {
      type: 'object',
      properties: {
        senderContains: {
          type: 'string',
          description: 'Case-insensitive substring match against the sender\'s address or display name.',
        },
        recipientContains: {
          type: 'string',
          description: 'Case-insensitive substring match against a to/cc recipient address.',
        },
        subjectContains: {
          type: 'string',
          description: 'Case-insensitive substring match against the subject line.',
        },
        keywords: {
          type: 'string',
          description: 'Free-text keywords to search the message body/snippet.',
        },
        dateFrom: {
          type: 'string',
          description: 'ISO 8601 date (YYYY-MM-DD). Only messages received on or after this date.',
        },
        dateTo: {
          type: 'string',
          description: 'ISO 8601 date (YYYY-MM-DD). Only messages received on or before this date.',
        },
        unreadOnly: {
          type: 'boolean',
          description: 'When true, only return unread messages.',
        },
        hasAttachment: {
          type: 'boolean',
          description: 'When true, only return messages that have at least one attachment.',
        },
        attachmentNameContains: {
          type: 'string',
          description: 'Case-insensitive substring match against an attachment file name.',
        },
        mailboxScope: {
          type: 'string',
          enum: ['mine'],
          description:
            'Which mailbox to search. "mine" (the requesting member\'s own mailbox) is the only supported value.',
        },
        maxResults: {
          type: 'integer',
          description: 'Maximum number of messages to return. Defaults to 10; capped at 25 regardless of the value requested.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

// §4.3 — fetch the normalized full body of one specific message or thread
// already surfaced by search_email_messages. Exactly one of messageId/
// threadId must be provided — plain JSON Schema cannot express an
// exclusive-or cleanly, so this is stated in the description and enforced
// by Relativity/services/emailToolValidation.js#validateGetEmailContentArgs.
const GET_EMAIL_CONTENT_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAMES.GET_EMAIL_CONTENT,
    description:
      'Fetch the normalized full body of one specific message or thread, identified by an id previously returned ' +
      'by search_email_messages. Exactly one of messageId or threadId must be provided, never both, never neither.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description:
            'The id of a single message to fetch, as returned by search_email_messages. Exactly one of ' +
            'messageId/threadId must be provided.',
        },
        threadId: {
          type: 'string',
          description:
            'The id of a thread to fetch every message in, as returned by search_email_messages. Exactly one ' +
            'of messageId/threadId must be provided.',
        },
        maxMessagesInThread: {
          type: 'integer',
          description:
            'Maximum number of messages to return when fetching a thread. Defaults to 5; capped at 20 ' +
            'regardless of the value requested. Ignored when messageId is used instead of threadId.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

// The array a future tools-aware generation call (EL5) will spread in
// directly, e.g. `tools: [...EMAIL_TOOLS]`.
const EMAIL_TOOLS = [SEARCH_EMAIL_MESSAGES_TOOL, GET_EMAIL_CONTENT_TOOL];

module.exports = {
  TOOL_NAMES,
  SEARCH_EMAIL_MESSAGES_TOOL,
  GET_EMAIL_CONTENT_TOOL,
  EMAIL_TOOLS,
};
