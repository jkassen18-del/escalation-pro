import type { DbDriver } from './driver.ts';
import { addColumnToMysql, indexToMysql, tableToMysql } from './mysql-dialect.ts';
import { syncRoles } from './roles-sync.ts';

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
    role_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    system_key TEXT,
    tier TEXT NOT NULL DEFAULT 'agent',
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
    sla_notified_due TEXT,
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

  /* ---------------------------------------------------------------------
   * Operations: monitoring, alerts, on-call, status pages, backups.
   * ------------------------------------------------------------------- */

  `CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    interval_secs INTEGER NOT NULL DEFAULT 60,
    grace_secs INTEGER NOT NULL DEFAULT 300,
    failure_threshold INTEGER NOT NULL DEFAULT 2,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    severity TEXT NOT NULL DEFAULT 'sev2',
    escalation_policy_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending',
    /* Heartbeat monitors only: the secret in the ping URL. */
    heartbeat_token TEXT UNIQUE,
    last_ping_at TEXT,
    last_fail_at TEXT,
    last_checked_at TEXT,
    last_change_at TEXT,
    last_latency_ms INTEGER,
    last_message TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /* Raw results, kept for a week. */
  `CREATE TABLE IF NOT EXISTS monitor_checks (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,

  /* One row per monitor per UTC day, kept for the status pages' 90-day bars. */
  `CREATE TABLE IF NOT EXISTS monitor_daily (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (monitor_id, day)
  )`,

  `CREATE TABLE IF NOT EXISTS alert_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    escalation_policy_id TEXT,
    default_severity TEXT NOT NULL DEFAULT 'sev3',
    mapping TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_event_at TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Every signal, from a monitor or a webhook, normalised. A repeat of an
   * alert that is still open increments `count` rather than adding a row.
   */
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'firing',
    count INTEGER NOT NULL DEFAULT 1,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    suppressed INTEGER NOT NULL DEFAULT 0,
    payload TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS maintenance_windows (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    monitor_ids TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS oncall_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    time_zone TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS oncall_layers (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    rotation TEXT NOT NULL DEFAULT 'weekly',
    shift_hours INTEGER NOT NULL DEFAULT 168,
    starts_at TEXT NOT NULL,
    member_ids TEXT NOT NULL DEFAULT '[]'
  )`,

  `CREATE TABLE IF NOT EXISTS oncall_overrides (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    note TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS escalation_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    repeat_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS escalation_levels (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    delay_mins INTEGER NOT NULL DEFAULT 10,
    targets TEXT NOT NULL DEFAULT '[]'
  )`,

  /* Each person's own "how to reach me" rules. No rows means the defaults. */
  `CREATE TABLE IF NOT EXISTS notification_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    urgency TEXT NOT NULL,
    channel TEXT NOT NULL,
    delay_mins INTEGER NOT NULL DEFAULT 0
  )`,

  /*
   * One escalation in flight, for one ticket. The pager walks it level by
   * level until someone acknowledges, the ticket resolves, or the policy runs out.
   */
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    policy_id TEXT,
    severity TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'high',
    status TEXT NOT NULL DEFAULT 'triggered',
    current_level INTEGER NOT NULL DEFAULT 0,
    cycle INTEGER NOT NULL DEFAULT 0,
    level_started_at TEXT NOT NULL,
    current_targets TEXT NOT NULL DEFAULT '[]',
    acknowledged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /* Every attempt to reach someone: sent, delivered, answered, acknowledged. */
  `CREATE TABLE IF NOT EXISTS notification_attempts (
    id TEXT PRIMARY KEY,
    page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    cycle INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0,
    external_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS status_pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    components TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /* Written by people, for the public: never derived from internal comments. */
  `CREATE TABLE IF NOT EXISTS status_updates (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS backup_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL,
    connection_encrypted TEXT NOT NULL,
    connection_hint TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '0 1 * * *',
    retention TEXT NOT NULL DEFAULT '{}',
    destination TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    heartbeat_monitor_id TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    run_trigger TEXT NOT NULL DEFAULT 'schedule',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    location TEXT,
    /* The per-backup data key, wrapped with the instance key. */
    wrapped_key TEXT,
    error TEXT
  )`,

  /* Who holds the scheduler, so two instances never run the same job twice. */
  `CREATE TABLE IF NOT EXISTS leases (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,

  /*
   * Outbound HTTP integrations an administrator defines themselves: any URL,
   * any headers, an optional body template. Header values and the signing
   * secret are encrypted at rest and never sent back to the browser.
   */
  `CREATE TABLE IF NOT EXISTS http_integrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST',
    headers_encrypted TEXT,
    body_template TEXT,
    signing_secret_encrypted TEXT,
    allow_private INTEGER NOT NULL DEFAULT 0,
    events TEXT NOT NULL DEFAULT '{}',
    team_ids TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Which department each Linear team's issues belong to. Several Linear
   * teams may feed one department; the one marked primary is where that
   * department's tickets are mirrored out to (kept in team_routing too).
   */
  `CREATE TABLE IF NOT EXISTS linear_team_map (
    linear_team_id TEXT PRIMARY KEY,
    linear_team_key TEXT,
    linear_team_name TEXT,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    is_primary INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Alert routing rules, evaluated in `position` order before the default
   * routing (the source's own policy, then its team's).
   */
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    match_spec TEXT NOT NULL DEFAULT '{}',
    actions TEXT NOT NULL DEFAULT '{}',
    continue_evaluating INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * SAML single sign-on. Request ids are kept in the database rather than in
   * memory, so a login started on one instance can finish on another; and
   * every assertion id that has been accepted is remembered until it would
   * have expired anyway, so a captured response cannot be replayed.
   */
  `CREATE TABLE IF NOT EXISTS saml_requests (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS saml_assertions (
    id TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  )`,

  /* Links from a team to the other systems it works in: AWS, Azure, Entra ID... */
  `CREATE TABLE IF NOT EXISTS team_links (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'generic',
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Quick tickets: a templated kind of ticket ("Site issue", "New laptop")
   * that goes straight to one department with the right type, priority and
   * questions already decided, so the person raising it only adds details.
   */
  `CREATE TABLE IF NOT EXISTS ticket_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT NOT NULL DEFAULT 'ticket',
    color TEXT NOT NULL DEFAULT '#6b7280',
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    ticket_type TEXT NOT NULL DEFAULT 'request',
    priority TEXT NOT NULL DEFAULT 'normal',
    severity TEXT,
    subject_template TEXT NOT NULL DEFAULT '{{name}}: {{summary}}',
    guidance TEXT,
    /* The template's own questions, as a JSON list of form fields. */
    fields TEXT NOT NULL DEFAULT '[]',
    /* 'off', 'encouraged' or 'required'. */
    screenshot TEXT NOT NULL DEFAULT 'encouraged',
    tags TEXT NOT NULL DEFAULT '[]',
    /* Teams whose members may use it; empty means everyone. */
    audience_team_ids TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Labels a department picks from instead of typing free-text tags. A null
   * team_id is an organisation-wide label offered to every department.
   * Tickets still store the label's name in their tags, lower-cased, so
   * filtering by tag and the integrations that read tags keep working.
   */
  `CREATE TABLE IF NOT EXISTS team_labels (
    id TEXT PRIMARY KEY,
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6b7280',
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /*
   * Browser and phone push subscriptions. One person can have several (a
   * phone and a laptop); a subscription the push service reports as gone is
   * deleted on the next send.
   */
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    /* SHA-256 of the endpoint, which is the key: endpoints can be longer
       than MySQL will index. */
    endpoint_hash TEXT NOT NULL UNIQUE,
    endpoint TEXT NOT NULL,
    /* \"keys\" is reserved in MySQL. */
    key_material TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,

  /*
   * One-time "state" values for OAuth installs (Add to Slack, Microsoft admin
   * consent). Only a hash is stored; each is single-use, expires in minutes,
   * and is bound to the session that started it, so a link cannot be
   * replayed or completed in someone else's browser.
   */
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,

  /* Short-lived codes from Discord's /link, typed into a profile to prove the account. */
  `CREATE TABLE IF NOT EXISTS discord_link_codes (
    code TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,

  /* ---------------------------------------------------------------------
   * Claude connector (MCP): personal access tokens and OAuth 2.1.
   * Every token is stored as a SHA-256 hash; the plain value is shown once.
   * ------------------------------------------------------------------- */

  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    /* First characters of the token, so people can tell theirs apart. */
    token_prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'read',
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,

  /* Clients registered dynamically (RFC 7591) or by metadata document URL. */
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'dcr',
    secret_hash TEXT,
    created_by TEXT,
    created_ip TEXT,
    fetched_at TEXT,
    created_at TEXT NOT NULL
  )`,

  /* An authorization request waiting for the person's consent. */
  `CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT,
    resource TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  /* One person's approval of one client: what "Connected apps" lists. */
  `CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,

  /* Authorization codes, access tokens and refresh tokens, all hashed. */
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    redirect_uri TEXT,
    code_challenge TEXT,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,

  /* Invite links people use to sign themselves up into a department. */
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    role_id TEXT NOT NULL,
    email TEXT,
    allowed_domains TEXT NOT NULL DEFAULT '[]',
    team_ids TEXT NOT NULL DEFAULT '[]',
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  )`,

  /*
   * One row per use of an invite, numbered. The (invite_id, seq) key is what
   * stops two people taking the last use of a link at the same moment.
   */
  `CREATE TABLE IF NOT EXISTS invite_uses (
    invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    claim_id TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (invite_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
];

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_ip, created_at)`,
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
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_external ON notification_attempts(external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_monitor_checks ON monitor_checks(monitor_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_monitors_next ON monitors(next_check_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(source_id, dedup_key, status)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_ticket ON alerts(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_layers_schedule ON oncall_layers(schedule_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_overrides_schedule ON oncall_overrides(schedule_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS idx_levels_policy ON escalation_levels(policy_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_rules_user ON notification_rules(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)`,
  `CREATE INDEX IF NOT EXISTS idx_pages_ticket ON pages(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_page ON notification_attempts(page_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_status_updates_page ON status_updates(status_page_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_backup_runs_job ON backup_runs(job_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_team_links_team ON team_links(team_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_team_labels_team ON team_labels(team_id, position)`,
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
export const ADDITIVE_COLUMNS: AdditiveColumn[] = [
  {
    table: 'monitors',
    column: 'last_fail_at',
    definition: `TEXT`,
    why: 'a heartbeat whose job reported a failure stays down until its next success ping',
  },
  {
    table: 'maintenance_windows',
    column: 'description',
    definition: `TEXT`,
    why: 'shown on status pages when the window is published',
  },
  {
    table: 'maintenance_windows',
    column: 'scope',
    definition: `TEXT NOT NULL DEFAULT '{}'`,
    why: 'monitors, sources, teams or components a window covers; empty falls back to monitor_ids',
  },
  {
    table: 'maintenance_windows',
    column: 'effect',
    definition: `TEXT NOT NULL DEFAULT 'pause_paging'`,
    why: 'pause paging only, or pause alerting entirely',
  },
  {
    table: 'maintenance_windows',
    column: 'recurrence',
    definition: `TEXT NOT NULL DEFAULT '{}'`,
    why: 'daily, weekly or monthly windows, expanded on the fly',
  },
  {
    table: 'maintenance_windows',
    column: 'time_zone',
    definition: `TEXT NOT NULL DEFAULT 'Africa/Johannesburg'`,
    why: 'the zone the wall-clock time of a recurring window is written in',
  },
  {
    table: 'maintenance_windows',
    column: 'notify_before_mins',
    definition: `INTEGER NOT NULL DEFAULT 0`,
    why: 'warn the affected teams before a window starts',
  },
  {
    table: 'maintenance_windows',
    column: 'publish',
    definition: `INTEGER NOT NULL DEFAULT 0`,
    why: 'show the window on status pages',
  },
  {
    table: 'maintenance_windows',
    column: 'overrides',
    definition: `TEXT NOT NULL DEFAULT '{}'`,
    why: 'per-occurrence early ends, extensions and skips',
  },
  {
    table: 'maintenance_windows',
    column: 'announced',
    definition: `TEXT NOT NULL DEFAULT '{}'`,
    why: 'which notices each occurrence has already sent, so they go out once',
  },
  {
    table: 'maintenance_windows',
    column: 'cancelled_at',
    definition: `TEXT`,
    why: 'a cancelled window stays in the history',
  },
  {
    table: 'maintenance_windows',
    column: 'updated_at',
    definition: `TEXT`,
    why: 'last edit',
  },
  {
    table: 'monitor_daily',
    column: 'maintenance',
    definition: `INTEGER NOT NULL DEFAULT 0`,
    why: 'failed checks during maintenance count as neither up nor down',
  },
  {
    table: 'alerts',
    column: 'maintenance_id',
    definition: `TEXT`,
    why: 'the window that suppressed an alert, so it can be raised again when the window ends',
  },
  {
    table: 'oncall_layers',
    column: 'entries',
    definition: `TEXT NOT NULL DEFAULT '[]'`,
    why: 'roster layers list who covers which dates explicitly instead of rotating',
  },
  {
    table: 'alerts',
    column: 'rule_name',
    definition: 'TEXT',
    why: 'which routing rule decided where an alert went',
  },
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
  {
    table: 'tickets',
    column: 'severity',
    definition: 'TEXT',
    why: 'incidents carry SEV1-SEV4 alongside the priority',
  },
  {
    table: 'tickets',
    column: 'commander_id',
    definition: 'TEXT',
    why: 'the incident commander, who may differ from the assignee',
  },
  {
    table: 'users',
    column: 'role_id',
    definition: 'TEXT',
    why: 'the role a person holds, now that roles can be created and edited',
  },
  {
    table: 'users',
    column: 'teams_user_id',
    definition: 'TEXT',
    why: "the person's Entra object id, which a Teams call has to be addressed to",
  },
  {
    table: 'status_pages',
    column: 'appearance',
    definition: `TEXT NOT NULL DEFAULT '{}'`,
    why: 'theme, brand colour, logo and custom CSS for each status page',
  },
  {
    table: 'tickets',
    column: 'template_id',
    definition: 'TEXT',
    why: 'which quick-ticket template a ticket was raised from',
  },
  {
    table: 'ticket_comments',
    column: 'is_system',
    definition: 'INTEGER NOT NULL DEFAULT 0',
    why: 'notes written by monitors and the pager, told apart from a deleted author',
  },
  {
    table: 'users',
    column: 'discord_user_id',
    definition: 'VARCHAR(32)',
    why: 'the Discord account linked with /link, for tickets, replies and pages from Discord',
  },
  {
    table: 'users',
    column: 'discord_username',
    definition: 'VARCHAR(100)',
    why: 'shown on the profile next to the linked Discord account',
  },
  {
    table: 'teams',
    column: 'escalation_policy_id',
    definition: 'TEXT',
    why: "the policy that pages for this team's alerts unless a monitor names its own",
  },
  {
    table: 'tickets',
    column: 'sla_notified_due',
    definition: 'TEXT',
    why: 'the due date an SLA breach was announced for, so each breach is announced once across restarts and instances',
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
  const failures: Array<{ table: string; column: string; ddl: string; why: string; message: string }> = [];
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
      // Keep going: the operator should get every statement in one go, not
      // one per restart.
      failures.push({ table, column, ddl, why, message });
    }
  }
  if (!failures.length) return;

  /*
   * Almost always ownership: the database user can read and write the
   * tables but did not create them, and only an owner may alter them.
   * Nothing the app can do about that, so say exactly what to run instead
   * of failing with a message that names neither the cause nor the cure.
   */
  const tables = [...new Set(failures.map((failure) => failure.table))];
  const script = failures
    .map((failure) =>
      driver.dialect === 'mysql' ? `${failure.ddl};` : `${failure.ddl.replace(' ADD COLUMN ', ' ADD COLUMN IF NOT EXISTS ')};`,
    )
    .join('\n  ');
  const remedy =
    driver.dialect === 'mysql'
      ? `The application's database user lacks ALTER on ${tables.length > 1 ? 'these tables' : 'this table'}. ` +
        `Run this once as a user that has it:\n\n  ${script}\n\nTo stop this recurring:\n\n` +
        `  GRANT ALTER ON <database>.* TO '<the user in DATABASE_URL>'@'<host>';`
      : `The application's database user can read and write ${tables.length > 1 ? 'these tables' : 'this table'} but does not own ` +
        `${tables.length > 1 ? 'them' : 'it'}, and PostgreSQL only lets a table's owner alter it. Run this once as the owner ` +
        `(or as a superuser):\n\n  ${script}\n\n` +
        `To stop this recurring, give the tables to the application's user:\n\n  ` +
        tables.map((table) => `ALTER TABLE ${table} OWNER TO <the user in DATABASE_URL>;`).join('\n  ');

  const lines = failures.map((failure) => `  - "${failure.column}" on "${failure.table}" (${failure.why}): ${failure.message.split('\n')[0]}`);
  throw new Error(
    `Could not add ${failures.length === 1 ? 'a column' : `${failures.length} columns`} the app needs:\n` +
      `${lines.join('\n')}\n\n` +
      remedy,
  );
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
  // Two instances starting together would otherwise race each other's DDL.
  await driver.withLock('migrate', () => migrateUnlocked(driver));
}

async function migrateUnlocked(driver: DbDriver): Promise<void> {
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
  await syncRoles(driver);
}
