import { db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';

/**
 * Conversations the Teams bot has been added to.
 *
 * Microsoft will not let a bot message a conversation it has never seen, so
 * a notification can only be sent somewhere the bot was installed. The
 * reference is captured the first time an activity arrives from a
 * conversation and refreshed on every later one, because the service URL can
 * change when a tenant is moved between clouds.
 */
export interface TeamsConversation {
  id: string;
  conversationId: string;
  serviceUrl: string;
  tenantId: string | null;
  channelName: string | null;
  teamName: string | null;
  updatedAt: string;
}

interface Row {
  id: string;
  conversation_id: string;
  service_url: string;
  tenant_id: string | null;
  channel_name: string | null;
  team_name: string | null;
  updated_at: string;
}

const map = (row: Row): TeamsConversation => ({
  id: row.id,
  conversationId: row.conversation_id,
  serviceUrl: row.service_url,
  tenantId: row.tenant_id,
  channelName: row.channel_name,
  teamName: row.team_name,
  updatedAt: row.updated_at,
});

export interface RememberInput {
  conversationId: string;
  serviceUrl: string;
  tenantId?: string | null;
  channelName?: string | null;
  teamName?: string | null;
}

export async function rememberConversation(input: RememberInput): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO teams_conversations (id, conversation_id, service_url, tenant_id, channel_name, team_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET
       service_url = excluded.service_url,
       tenant_id = excluded.tenant_id,
       channel_name = excluded.channel_name,
       team_name = excluded.team_name,
       updated_at = excluded.updated_at`,
    [
      randomId(),
      input.conversationId,
      input.serviceUrl,
      input.tenantId ?? null,
      input.channelName ?? null,
      input.teamName ?? null,
      now,
      now,
    ],
  );
}

export async function findConversation(conversationId: string): Promise<TeamsConversation | null> {
  const row = await db.get<Row>(`SELECT * FROM teams_conversations WHERE conversation_id = ?`, [conversationId]);
  return row ? map(row) : null;
}

export async function listConversations(): Promise<TeamsConversation[]> {
  const rows = await db.all<Row>(`SELECT * FROM teams_conversations ORDER BY updated_at DESC`);
  return rows.map(map);
}

/**
 * Where a notification goes when nothing more specific is configured.
 *
 * The most recently active conversation, which for a single-channel
 * deployment is the only one and is therefore right. A deployment with
 * several channels sets a per-department target instead.
 */
export async function defaultConversation(): Promise<TeamsConversation | null> {
  const row = await db.get<Row>(`SELECT * FROM teams_conversations ORDER BY updated_at DESC`);
  return row ? map(row) : null;
}
