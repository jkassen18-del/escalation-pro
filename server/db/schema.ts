import type { DbDriver } from './driver.ts';
import { addColumnToMysql, indexToMysql, tableToMysql } from './mysql-dialect.ts';

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
  /*
   * Connections to databases the company already runs, used to look up real
   * records (customers, assets) when raising a ticket.
   *
   * The credential is encrypted at rest with the same key as the integration
   * secrets. Nothing here is ever returned to the browser in the clear.
   */
  `CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_encrypted TEXT,
    use_tls INTEGER NOT NULL DEFAULT 1,
    lookup_query TEXT NOT NULL,
    value_column TEXT NOT NULL DEFAULT 'id',
    label_column TEXT NOT NULL DEFAULT 'name',
    status TEXT NOT NULL DEFAULT 'unknown',
    status_message TEXT,
    last_tested_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Where each department's tickets are announced.
   *
   * One row per team per provider, overriding the integration's default. HR
   * tickets go to the HR channel and ping the HR group; IT tickets go to IT.
   * Without a row a team simply uses the default, so this is additive and a
   * deployment that wants one channel for everything needs no rows at all.
   */
  `CREATE TABLE IF NOT EXISTS team_routing (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    /* Slack channel id, Teams webhook URL, or Linear team id. */
    target TEXT NOT NULL DEFAULT '',
    /* Slack only: who to mention, e.g. a user group or @here. */
    mention TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, provider)
  )`,

  /*
   * Per-department intake forms. Each team defines the questions its own
   * tickets should answer, on top of the fields every ticket has.
   */
  `CREATE TABLE IF NOT EXISTS team_form_fields (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    required INTEGER NOT NULL DEFAULT 0,
    help_text TEXT,
    placeholder TEXT,
    options TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    /* Set only for lookup fields, which read their options from an
       external database connection. */
    data_source_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (team_id, field_key)
  )`,

  /*
   * Answers, with the question copied alongside them.
   *
   * The label and type are snapshotted rather than joined from the field
   * definition on read: a ticket raised last year should still say what was
   * actually asked, even after the form has been reworded or the field
   * deleted. field_id is kept for grouping but is deliberately not a foreign
   * key, so removing a field never erases the history of what people answered.
   */
  `CREATE TABLE IF NOT EXISTS ticket_field_values (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    field_id TEXT,
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (ticket_id, field_key)
  )`,

  `CREATE TABLE IF NOT EXISTS branding_assets (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Where the Teams bot has been installed.
   *
   * A bot cannot start a conversation out of nowhere: Microsoft only accepts
   * a message addressed to a conversation it has already seen, so the
   * reference is recorded the first time the bot is added to a channel and
   * reused for every notification afterwards. Without this row a department's
   * tickets have nowhere in Teams to go.
   */
  `CREATE TABLE IF NOT EXISTS teams_conversations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    /* Replies must be posted back to the host that sent the activity, which
       differs per tenant and per cloud. */
    service_url TEXT NOT NULL,
    tenant_id TEXT,
    /* For the admin UI to show something recognisable in the picker. */
    channel_name TEXT,
    team_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Keys for the HTTPS API.
   *
   * The secret is never stored - only a SHA-256 of it, the way a password is
   * handled, so a copy of this table does not let anyone raise tickets. The
   * prefix is kept in the clear purely so a key can be recognised in the UI
   * and in the audit trail without being reversible.
   */
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    /* The visible half, e.g. "itk_9f3a2b1c". Unique so a lookup is one row. */
    prefix TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    /* JSON array of permissions this key may exercise, never more than the
       person who created it holds. */
    scopes TEXT NOT NULL DEFAULT '[]',
    /* Tickets raised with this key default to this department. */
    default_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * InfraGrid: the monitoring systems that can raise alerts here.
   *
   * Each connected system gets its own ingest credential rather than sharing
   * one, so a compromised Jenkins cannot impersonate CrowdStrike, and any one
   * of them can be turned off without touching the others.
   */
  `CREATE TABLE IF NOT EXISTS alert_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    /* Which vendor's payload shape to expect. */
    kind TEXT NOT NULL,
    /* The visible half of the ingest credential, for the UI and the logs. */
    token_prefix TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    /* Where this system's alerts are routed. */
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    /* Alerts at or above this severity open a ticket; below it they are
       recorded and shown but do not wake anybody. */
    ticket_threshold TEXT NOT NULL DEFAULT 'warning',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_event_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * One row per condition, not per notification.
   *
   * A monitor re-fires while a condition persists, so repeats fold into the
   * row that is already firing and only advance its counter. The alternative
   * is a table that grows by thousands of rows for one bad disk.
   */
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES alert_sources(id) ON DELETE CASCADE,
    /* Stable per condition, so repeats and the eventual recovery match up. */
    dedupe_key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    /* critical | warning | info */
    severity TEXT NOT NULL DEFAULT 'warning',
    /* firing | resolved */
    status TEXT NOT NULL DEFAULT 'firing',
    /* The host, service or pipeline it is about. */
    resource TEXT,
    /* A link back into the system that raised it. */
    external_url TEXT,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT
  )`,

  /*
   * Dead-man's switches.
   *
   * The inverse of an alert: silence is the failure. A cron job that stops
   * running sends nothing at all, so nothing else in this system would ever
   * notice. A heartbeat that misses its window raises an alert like any other.
   */
  `CREATE TABLE IF NOT EXISTS heartbeats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    /* The token that appears in the check-in URL. */
    slug TEXT NOT NULL UNIQUE,
    /* How often it is expected, and how late it may be before that counts. */
    period_seconds INTEGER NOT NULL DEFAULT 3600,
    grace_seconds INTEGER NOT NULL DEFAULT 300,
    severity TEXT NOT NULL DEFAULT 'warning',
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_beat_at TEXT,
    /* ok | missed | new */
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS idx_form_fields_team ON team_form_fields(team_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_field_values_ticket ON ticket_field_values(ticket_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(source_id, dedupe_key, status)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_prefix ON alert_sources(token_prefix)`,
];

/**
 * Columns added after the first release, so an existing database upgrades in
 * place without a migration tool.
 *
 * Plain ADD COLUMN rather than IF NOT EXISTS: SQLite does not support that
 * clause and rejects it as a syntax error. Re-running is handled by treating
 * "already exists" as success, which both engines report.
 */
interface AdditiveColumn {
  table: string;
  column: string;
  definition: string;
  why: string;
}

/**
 * Columns added after the first release, so an existing database upgrades in
 * place without a migration tool.
 */
const ADDITIVE_COLUMNS: AdditiveColumn[] = [
  {
    table: 'ticket_attachments',
    column: 'content',
    definition: 'TEXT',
    why: 'holds attachment bytes where there is no persistent disk',
  },
  {
    table: 'tickets',
    column: 'description_format',
    definition: `TEXT NOT NULL DEFAULT 'text'`,
    why: 'rich text arrived after plain text, and existing rows must keep rendering as plain',
  },
  {
    table: 'ticket_comments',
    column: 'body_format',
    definition: `TEXT NOT NULL DEFAULT 'text'`,
    why: 'same, for comment bodies',
  },
];

/**
 * Whether a column is already present.
 *
 * Asked before altering rather than altering and interpreting the error.
 * ALTER TABLE requires *ownership* of the table, not merely privileges on it,
 * so a deployment whose tables were created by a different role gets
 * "must be owner" for a column that is simply already there - and the two
 * cases need opposite responses.
 */
async function columnExists(driver: DbDriver, table: string, column: string): Promise<boolean> {
  if (driver.dialect === 'mysql') {
    const row = await driver.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_name = ? AND column_name = ? AND table_schema = DATABASE()`,
      [table, column],
    );
    return Number(row?.n ?? 0) > 0;
  }

  if (driver.dialect === 'postgres') {
    const row = await driver.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_name = ? AND column_name = ? AND table_schema = current_schema()`,
      [table, column],
    );
    return Number(row?.n ?? 0) > 0;
  }

  // Table names here are constants in this file, never user input.
  const rows = await driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

async function applyAdditiveColumns(driver: DbDriver): Promise<void> {
  for (const { table, column, definition, why } of ADDITIVE_COLUMNS) {
    if (await columnExists(driver, table, column)) continue;

    const ddl =
      driver.dialect === 'mysql'
        ? addColumnToMysql(table, column, definition)
        : `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`;
    try {
      await driver.run(ddl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Raced with another instance starting at the same time.
      if (/duplicate column|already exists/i.test(message)) continue;

      /*
       * Almost always ownership: the database user can read and write the
       * table but did not create it, and only its owner may alter it. Nothing
       * the app can do about that, so say exactly what to run instead of
       * failing with a message that names neither the cause nor the cure.
       */
      const remedy =
        driver.dialect === 'mysql'
          ? `The application's database user lacks ALTER on this table. Run this once as a user ` +
            `that has it:\n\n  ${ddl};\n\nTo stop this recurring:\n\n` +
            `  GRANT ALTER ON <database>.* TO '<the user in DATABASE_URL>'@'<host>';`
          : `The application's database user can read and write this table but does not own it, ` +
            `and PostgreSQL only lets a table's owner alter it. Run this once as the owner ` +
            `(or as a superuser):\n\n  ${ddl.replace(' ADD COLUMN ', ' ADD COLUMN IF NOT EXISTS ')};\n\n` +
            `To stop this recurring, give the table to the application's user:\n\n` +
            `  ALTER TABLE ${table} OWNER TO <the user in DATABASE_URL>;`;

      throw new Error(
        `Could not add the "${column}" column to "${table}" (${why}).\n` + `  ${message}\n\n` + remedy,
      );
    }
  }
}

/**
 * Whether an index is already there.
 *
 * Only MySQL needs asking: it has no CREATE INDEX IF NOT EXISTS, and re-running
 * a bare CREATE INDEX on an existing one is an error rather than a no-op.
 */
async function indexExists(driver: DbDriver, table: string, name: string): Promise<boolean> {
  const row = await driver.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
     WHERE table_name = ? AND index_name = ? AND table_schema = DATABASE()`,
    [table, name],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function migrate(driver: DbDriver): Promise<void> {
  for (const statement of TABLES) {
    await driver.run(driver.dialect === 'mysql' ? tableToMysql(statement, INDEXES) : statement);
  }
  await applyAdditiveColumns(driver);
  /*
   * Indexes are best-effort.
   *
   * CREATE INDEX also requires ownership of the table - and refuses on that
   * ground even when the index already exists, so a deployment whose tables
   * were created by another role cannot get past this. A missing index makes
   * queries slower; it does not make them wrong, and refusing to start over
   * one helps nobody. Missing *columns* are different and still fail hard,
   * because writes against them are broken.
   */
  for (const statement of INDEXES) {
    try {
      if (driver.dialect === 'mysql') {
        const index = indexToMysql(statement);
        if (!index) continue;
        if (await indexExists(driver, index.table, index.name)) continue;
        await driver.run(index.sql);
        continue;
      }
      await driver.run(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/must be owner|permission denied|already exists/i.test(message)) throw error;
      console.warn(`[db] skipped an index: ${message.split('\n')[0]}`);
    }
  }
  await driver.run(
    `INSERT INTO counters (name, value) VALUES ('ticket_number', 1000)
     ON CONFLICT (name) DO NOTHING`,
  );
}
