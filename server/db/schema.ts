import type { DbDriver } from './driver.ts';

/**
 * One portable schema for both engines.
 *
 * Deliberate choices that keep SQLite and Postgres byte-compatible:
 *  - ids are TEXT (uuid v4 strings), never engine-generated
 *  - timestamps are TEXT holding ISO-8601 UTC strings
 *  - booleans are INTEGER 0/1
 *  - structured columns are TEXT holding JSON, parsed in the application
 *
 * That avoids jsonb/boolean/timestamptz dialect drift entirely.
 */
const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    status TEXT NOT NULL DEFAULT 'active',
    job_title TEXT,
    phone TEXT,
    avatar_color TEXT NOT NULL DEFAULT '#9a7b2f',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS user_permissions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (user_id, permission)
  )`,

  `CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#6b7280',
    auto_assign TEXT NOT NULL DEFAULT 'none',
    default_priority TEXT NOT NULL DEFAULT 'normal',
    sla_response_mins INTEGER NOT NULL DEFAULT 240,
    sla_resolve_mins INTEGER NOT NULL DEFAULT 2880,
    last_assigned_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_lead INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    description_format TEXT NOT NULL DEFAULT 'text',
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    requester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    type TEXT NOT NULL DEFAULT 'request',
    source TEXT NOT NULL DEFAULT 'web',
    tags TEXT NOT NULL DEFAULT '[]',
    escalation_level INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    first_response_at TEXT,
    resolved_at TEXT,
    closed_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ticket_comments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    body_format TEXT NOT NULL DEFAULT 'text',
    is_internal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ticket_events (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    field TEXT,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ticket_attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    comment_id TEXT REFERENCES ticket_comments(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    -- Populated only when the attachment store is 'database' (serverless, where
    -- there is no persistent disk). Base64 so the column stays dialect-neutral.
    content TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ticket_watchers (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS ticket_links (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    external_key TEXT,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_name TEXT NOT NULL DEFAULT 'system',
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    meta TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS integrations (
    provider TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'unconfigured',
    last_checked_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS integration_deliveries (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event TEXT NOT NULL,
    ticket_id TEXT,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    error TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  /*
   * Branding images live in their own table rather than in `settings`, which
   * is read on almost every request - a base64 logo in that blob would be
   * fetched and parsed constantly for no reason.
   */
  `CREATE TABLE IF NOT EXISTS branding_assets (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
];

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_team ON tickets(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_due_at ON tickets(due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_links_ticket ON ticket_links(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON integration_deliveries(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, created_at)`,
];

/**
 * Columns added after the first release, so an existing database upgrades in
 * place without a migration tool.
 *
 * Plain ADD COLUMN rather than IF NOT EXISTS: SQLite does not support that
 * clause and rejects it as a syntax error. Re-running is handled by treating
 * "already exists" as success, which both engines report.
 */
const ADDITIVE_COLUMNS: string[] = [
  `ALTER TABLE ticket_attachments ADD COLUMN content TEXT`,
  /*
   * Rich text arrived after plain text, so every existing row holds plain
   * text and must keep rendering as such. The format travels with the value
   * rather than being inferred: guessing by sniffing for tags would mangle a
   * plain-text description that happens to mention <html>.
   */
  `ALTER TABLE tickets ADD COLUMN description_format TEXT NOT NULL DEFAULT 'text'`,
  `ALTER TABLE ticket_comments ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text'`,
];

export async function migrate(driver: DbDriver): Promise<void> {
  for (const statement of TABLES) {
    await driver.run(statement);
  }
  for (const statement of ADDITIVE_COLUMNS) {
    try {
      await driver.run(statement);
    } catch (error) {
      // Expected on every run after the first, and on a fresh database where
      // CREATE TABLE above already declared the column.
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }
  for (const statement of INDEXES) {
    await driver.run(statement);
  }
  await driver.run(
    `INSERT INTO counters (name, value) VALUES ('ticket_number', 1000)
     ON CONFLICT (name) DO NOTHING`,
  );
}
