'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_NAMES,
  SEARCH_EMAIL_MESSAGES_TOOL,
  GET_EMAIL_CONTENT_TOOL,
  EMAIL_TOOLS,
} = require('../services/emailToolSchemas');

// These two fixtures are the "provably identical" cross-repo check EL2's
// acceptance criteria call for (Architecture/architecture/LIVE_EMAIL_LOOKUP.md
// §4, EL2 milestone entry). Relativity/test/emailToolValidation.test.js
// hardcodes the SAME property/type/enum shape independently — if one repo's
// schema drifts from the other, this test (or its counterpart) fails, since
// there is no shared package between the two repos to enforce it at
// require-time.

const SEARCH_EMAIL_MESSAGES_PARAMETERS_FIXTURE = {
  type: 'object',
  properties: {
    senderContains: { type: 'string' },
    recipientContains: { type: 'string' },
    subjectContains: { type: 'string' },
    keywords: { type: 'string' },
    dateFrom: { type: 'string' },
    dateTo: { type: 'string' },
    unreadOnly: { type: 'boolean' },
    hasAttachment: { type: 'boolean' },
    attachmentNameContains: { type: 'string' },
    mailboxScope: { type: 'string', enum: ['mine'] },
    maxResults: { type: 'integer' },
  },
  required: [],
  additionalProperties: false,
};

const GET_EMAIL_CONTENT_PARAMETERS_FIXTURE = {
  type: 'object',
  properties: {
    messageId: { type: 'string' },
    threadId: { type: 'string' },
    maxMessagesInThread: { type: 'integer' },
  },
  required: [],
  additionalProperties: false,
};

function stripDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description') continue;
      out[key] = stripDescriptions(value);
    }
    return out;
  }
  return node;
}

test('TOOL_NAMES names exactly the two tools this registry defines', () => {
  assert.deepEqual(TOOL_NAMES, {
    SEARCH_EMAIL_MESSAGES: 'search_email_messages',
    GET_EMAIL_CONTENT: 'get_email_content',
  });
});

test('EMAIL_TOOLS contains exactly the two tools, in order, each shaped as an OpenAI function-tool entry', () => {
  assert.equal(EMAIL_TOOLS.length, 2);
  assert.equal(EMAIL_TOOLS[0], SEARCH_EMAIL_MESSAGES_TOOL);
  assert.equal(EMAIL_TOOLS[1], GET_EMAIL_CONTENT_TOOL);
  for (const tool of EMAIL_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.name, 'string');
    assert.equal(typeof tool.function.description, 'string');
    assert.ok(tool.function.description.length > 0);
    assert.equal(tool.function.parameters.type, 'object');
  }
});

test('search_email_messages parameters match the cross-repo fixture shape exactly (no description text)', () => {
  assert.equal(SEARCH_EMAIL_MESSAGES_TOOL.function.name, TOOL_NAMES.SEARCH_EMAIL_MESSAGES);
  assert.deepEqual(
    stripDescriptions(SEARCH_EMAIL_MESSAGES_TOOL.function.parameters),
    SEARCH_EMAIL_MESSAGES_PARAMETERS_FIXTURE
  );
});

test('get_email_content parameters match the cross-repo fixture shape exactly (no description text)', () => {
  assert.equal(GET_EMAIL_CONTENT_TOOL.function.name, TOOL_NAMES.GET_EMAIL_CONTENT);
  assert.deepEqual(
    stripDescriptions(GET_EMAIL_CONTENT_TOOL.function.parameters),
    GET_EMAIL_CONTENT_PARAMETERS_FIXTURE
  );
});

test('no tool declares a required field — every filter/argument is optional', () => {
  assert.deepEqual(SEARCH_EMAIL_MESSAGES_TOOL.function.parameters.required, []);
  assert.deepEqual(GET_EMAIL_CONTENT_TOOL.function.parameters.required, []);
});

test('both tools reject additional properties beyond their declared schema', () => {
  assert.equal(SEARCH_EMAIL_MESSAGES_TOOL.function.parameters.additionalProperties, false);
  assert.equal(GET_EMAIL_CONTENT_TOOL.function.parameters.additionalProperties, false);
});
