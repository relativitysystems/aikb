const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM1 — Multi-member schema foundation, AIKB side (Architecture/architecture/
// EMAIL_INGESTION.md §13.2, §28, §31). Schema only — no service in this repo
// writes email_source_messages/email_attachments yet, so there is no DI'd
// service layer to exercise the way test/aikbDatabaseProvider.test.js
// exercises a real module. This repo also has no migration-vs-code
// consistency test precedent the way Relativity's
// test/oauthConnectionsService.test.js does, and no test-database pattern
// for any existing migration. Consistent with both facts, this file proves
// the migration's invariants by parsing the actual migration SQL text.
//
// Limitation, stated plainly: these are static, text-level assertions
// against the migration's SQL, not an executed-against-a-real-database
// proof — this repo has no automated migration runner. A live-database run
// of this migration (fresh DB, and against the current pre-EM1 schema) was
// performed manually as part of this change's verification — see the
// implementation summary — but is not itself part of the automated suite.

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '010_email_source_em1.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

function checkValues(sql, columnName) {
  const re = new RegExp(`CHECK \\(${columnName} IN \\(([^)]+)\\)\\)`);
  const match = sql.match(re);
  assert.ok(match, `could not find a CHECK constraint for ${columnName}`);
  return match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

// ─────────────────────────────────────────────
// email_source_messages
// ─────────────────────────────────────────────

test('email_source_messages.provider CHECK constraint is exactly gmail/microsoft, matching Relativity\'s email_connections.provider', () => {
  assert.deepEqual(checkValues(MIGRATION_SQL, 'provider').sort(), ['gmail', 'microsoft']);
});

test('email_source_messages.document_id is 1:1 with knowledge_documents and cascades on delete', () => {
  assert.match(
    MIGRATION_SQL,
    /document_id\s+UUID\s+NOT NULL REFERENCES knowledge_documents\(id\) ON DELETE CASCADE/
  );
  const tableMatch = MIGRATION_SQL.match(/CREATE TABLE IF NOT EXISTS email_source_messages \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  assert.match(tableMatch[1], /UNIQUE \(document_id\)/);
});

test('email_source_messages.client_id remains present and required for tenant isolation', () => {
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS email_source_messages \(\s*\n\s*id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*\n\s*document_id[\s\S]*?\n\s*client_id\s+UUID\s+NOT NULL,/);
});

test('email_source_messages.contributing_member_id and ingestion_rule_id are plain UUIDs with no FK (cross-project references into Relativity)', () => {
  const tableMatch = MIGRATION_SQL.match(/CREATE TABLE IF NOT EXISTS email_source_messages \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  const body = tableMatch[1];

  const contributingLine = body.split('\n').find(l => l.includes('contributing_member_id'));
  assert.ok(contributingLine);
  assert.equal(/REFERENCES/.test(contributingLine), false, 'contributing_member_id must not be a real FK — it references Relativity\'s Global project');

  const ruleLine = body.split('\n').find(l => l.includes('ingestion_rule_id'));
  assert.ok(ruleLine);
  assert.equal(/REFERENCES/.test(ruleLine), false, 'ingestion_rule_id must not be a real FK — it references Relativity\'s Global project');
});

test('email_source_messages never declares a raw MIME/HTML storage column', () => {
  const tableMatch = MIGRATION_SQL.match(/CREATE TABLE IF NOT EXISTS email_source_messages \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  assert.equal(/raw_html|raw_mime|raw_body/i.test(tableMatch[1]), false, 'email_source_messages must never store raw HTML/MIME — only normalized text lives in knowledge_chunks');
});

test('email_source_messages has the three documented indexes: thread, message, and contributor lookups', () => {
  assert.match(MIGRATION_SQL, /email_source_messages_client_thread_idx\s*\n\s*ON email_source_messages \(client_id, provider_thread_id\);/);
  assert.match(MIGRATION_SQL, /email_source_messages_message_idx\s*\n\s*ON email_source_messages \(client_id, provider, provider_message_id\);/);
  assert.match(MIGRATION_SQL, /email_source_messages_contributor_idx\s*\n\s*ON email_source_messages \(client_id, contributing_member_id\);/);
});

// ─────────────────────────────────────────────
// email_attachments
// ─────────────────────────────────────────────

test('email_attachments.scan_status CHECK constraint matches the four documented statuses, defaulting to not_scanned', () => {
  assert.match(MIGRATION_SQL, /scan_status\s+TEXT\s+NOT NULL DEFAULT 'not_scanned'/);
  assert.deepEqual(
    checkValues(MIGRATION_SQL, 'scan_status').sort(),
    ['clean', 'flagged', 'not_scanned', 'scan_unavailable'].sort()
  );
});

test('email_attachments.extraction_status CHECK constraint matches the six documented statuses, defaulting to pending', () => {
  assert.match(MIGRATION_SQL, /extraction_status\s+TEXT\s+NOT NULL DEFAULT 'pending'/);
  assert.deepEqual(
    checkValues(MIGRATION_SQL, 'extraction_status').sort(),
    ['failed', 'ingested', 'password_protected', 'pending', 'too_large', 'unsupported_format'].sort()
  );
});

test('email_attachments.parent_document_id is required and cascades; attachment_document_id is optional (null until ingested)', () => {
  assert.match(MIGRATION_SQL, /parent_document_id\s+UUID\s+NOT NULL REFERENCES knowledge_documents\(id\) ON DELETE CASCADE/);
  assert.match(MIGRATION_SQL, /attachment_document_id\s+UUID\s+REFERENCES knowledge_documents\(id\) ON DELETE CASCADE,\s*--/);
  assert.equal(/attachment_document_id\s+UUID\s+NOT NULL/.test(MIGRATION_SQL), false);
});

test('email_attachments.client_id remains present for tenant isolation', () => {
  const tableMatch = MIGRATION_SQL.match(/CREATE TABLE IF NOT EXISTS email_attachments \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  assert.match(tableMatch[1], /client_id\s+UUID\s+NOT NULL,/);
});

test('email_attachments has a parent-lookup index', () => {
  assert.match(MIGRATION_SQL, /email_attachments_parent_idx\s*\n\s*ON email_attachments \(parent_document_id\);/);
});

// ─────────────────────────────────────────────
// Cross-cutting
// ─────────────────────────────────────────────

test('no CREATE POLICY / ENABLE ROW LEVEL SECURITY is introduced by this migration', () => {
  assert.equal(/CREATE POLICY|ENABLE ROW LEVEL SECURITY/.test(MIGRATION_SQL), false);
});

test('every CREATE TABLE/CREATE INDEX statement is idempotent (IF NOT EXISTS)', () => {
  const createTableStatements = [...MIGRATION_SQL.matchAll(/CREATE TABLE\s+(IF NOT EXISTS)?\s*(\w+)/g)];
  for (const [, guarded, tableName] of createTableStatements) {
    assert.ok(guarded, `CREATE TABLE ${tableName} must use IF NOT EXISTS`);
  }
  const createIndexStatements = [...MIGRATION_SQL.matchAll(/CREATE INDEX\s+(IF NOT EXISTS)?\s*(\S+)/g)];
  for (const [, guarded, indexName] of createIndexStatements) {
    assert.ok(guarded, `CREATE INDEX ${indexName} must use IF NOT EXISTS`);
  }
});
