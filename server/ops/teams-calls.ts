import crypto from 'node:crypto';
import { db } from '../db/index.ts';
import { badRequest } from '../lib/http.ts';
import { getOpsSetting, setOpsSetting } from '../repositories/settings.ts';
import { getBrandingMeta, putBrandingAsset, removeBrandingAsset } from '../repositories/branding.ts';
import { findUserById } from '../repositories/users.ts';
import { loadIntegration } from '../integrations/store.ts';
import type { MsTeamsConfig } from '../integrations/msteams.ts';
import type { PublicUser } from '../../shared/types.ts';
import type { TeamsCallSettings } from '../../shared/ops.ts';
import { publicBaseUrl } from './telephony.ts';

/**
 * Ringing the on-call person in Microsoft Teams.
 *
 * The Teams bot places a peer-to-peer call through Microsoft Graph's cloud
 * communications API with service-hosted media, so Teams rings on the
 * person's desktop and phone like any other call. Microsoft then posts the
 * call's progress to the calling webhook. With a recorded prompt uploaded,
 * the call plays it and listens for a keypress: 1 acknowledges, 2 escalates.
 * Without one, answering is recorded but does not acknowledge - the person
 * still has to acknowledge from Teams or the web, because an answered call
 * alone cannot be told apart from a pocket answer.
 *
 * Needs, in the bot's app registration: Calls.Initiate.All (place the call),
 * Calls.AccessMedia.All (listen for the keypress) and User.Read.All (find the
 * person's directory id from their email), all with admin consent; calling
 * enabled on the Azure Bot's Teams channel with the webhook below; and an
 * https App URL Microsoft can reach.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PROMPT_ASSET = 'teams-call-prompt';
/** Microsoft caps a prompt file at 512 KB. */
const MAX_PROMPT_BYTES = 512 * 1024;

interface StoredSettings {
  enabled?: boolean;
  /** Secret part of the prompt's public URL, so it cannot be guessed. */
  promptToken?: string;
}

export async function teamsCallSettings(): Promise<TeamsCallSettings> {
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  const prompt = stored.promptToken ? await getBrandingMeta(PROMPT_ASSET) : null;
  const base = await publicBaseUrl();
  const config = (await loadIntegration('msteams')).config as MsTeamsConfig;
  return {
    enabled: Boolean(stored.enabled),
    hasPrompt: Boolean(prompt),
    promptUpdatedAt: prompt?.updatedAt ?? null,
    callingWebhookUrl: base ? `${base}/api/webhooks/msteams/calling` : null,
    botConfigured: config.mode === 'bot' && Boolean(config.appId && config.appPassword && config.tenantId),
  };
}

export async function setTeamsCallsEnabled(enabled: boolean): Promise<TeamsCallSettings> {
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  await setOpsSetting('teamsCalls', { ...stored, enabled });
  return teamsCallSettings();
}

/* ------------------------------ The prompt -------------------------------- */

/**
 * Checks a prompt is what service-hosted media plays: WAV, PCM, one channel,
 * 16-bit samples at 16 kHz. Anything else Microsoft refuses mid-call, which
 * is the worst moment to find out.
 */
export function validatePromptWav(bytes: Buffer): void {
  if (bytes.length > MAX_PROMPT_BYTES) throw badRequest('The prompt must be 512 KB or smaller (about 15 seconds at 16 kHz).');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('The prompt must be a WAV file.');
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      const format = bytes.readUInt16LE(offset + 8);
      const channels = bytes.readUInt16LE(offset + 10);
      const sampleRate = bytes.readUInt32LE(offset + 12);
      const bits = bytes.readUInt16LE(offset + 22);
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw badRequest(
          `Teams plays only mono, 16-bit, 16 kHz PCM WAV. This file is ${channels === 1 ? 'mono' : `${channels}-channel`}, ${bits}-bit, ${sampleRate / 1000} kHz${format === 1 ? '' : ', compressed'}.`,
        );
      }
      return;
    }
    offset += 8 + size + (size % 2);
  }
  throw badRequest('The WAV file has no format section.');
}

export async function savePrompt(bytes: Buffer): Promise<TeamsCallSettings> {
  validatePromptWav(bytes);
  await putBrandingAsset(bytes, 'audio/wav', PROMPT_ASSET);
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  // A new token per upload: Microsoft caches prompts by URL.
  await setOpsSetting('teamsCalls', { ...stored, promptToken: crypto.randomBytes(18).toString('base64url') });
  return teamsCallSettings();
}

export async function removePrompt(): Promise<TeamsCallSettings> {
  await removeBrandingAsset(PROMPT_ASSET);
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  await setOpsSetting('teamsCalls', { ...stored, promptToken: undefined });
  return teamsCallSettings();
}

/** The prompt, if `token` is the current one. Served publicly: Microsoft fetches it. */
export async function promptByToken(token: string): Promise<Buffer | null> {
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  if (!stored.promptToken || token.length !== stored.promptToken.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(stored.promptToken))) return null;
  const row = await db.get<{ content: string }>(`SELECT content FROM branding_assets WHERE id = ?`, [PROMPT_ASSET]);
  return row ? Buffer.from(row.content, 'base64') : null;
}

async function promptUrl(): Promise<string | null> {
  const stored = await getOpsSetting<StoredSettings>('teamsCalls', {});
  const base = await publicBaseUrl();
  if (!stored.promptToken || !base) return null;
  return `${base}/api/public/teams-call-prompt/${stored.promptToken}.wav`;
}

/* --------------------------------- Graph ---------------------------------- */

async function botConfig(): Promise<MsTeamsConfig> {
  return (await loadIntegration('msteams')).config as MsTeamsConfig;
}

let graphToken: { token: string; expiresAt: number; key: string } | null = null;

export function resetTeamsCallCaches(): void {
  graphToken = null;
}

/** An app-only Graph token for the bot's own app registration, in the company's tenant. */
async function getGraphToken(config: MsTeamsConfig): Promise<string> {
  const key = `${config.tenantId}:${config.appId}`;
  if (graphToken && graphToken.key === key && graphToken.expiresAt - 5 * 60_000 > Date.now()) return graphToken.token;
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId!)}/oauth2/v2.0/token`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.appId!,
      client_secret: config.appPassword!,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Microsoft refused the bot's credentials for Graph: ${body.error_description?.split('\n')[0] ?? `HTTP ${response.status}`}`);
  }
  graphToken = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000, key };
  return graphToken.token;
}

/** Graph's error, with the fix spelled out for the permission problems everyone hits first. */
async function graphError(response: Response, what: string, permission: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const detail = body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return new Error(`${what} was refused (${detail}). Grant the bot's app registration the Microsoft Graph application permission ${permission} and an administrator's consent.`);
  }
  return new Error(`${what} failed: ${detail}`);
}

async function graph(config: MsTeamsConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await getGraphToken(config);
  return fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * The person's Entra object id, which a call is addressed to. Looked up by
 * email once and remembered; the Teams bot also records it whenever it sees
 * the person in a conversation.
 */
export async function teamsUserIdFor(config: MsTeamsConfig, user: PublicUser): Promise<string> {
  const row = await db.get<{ teams_user_id: string | null }>(`SELECT teams_user_id FROM users WHERE id = ?`, [user.id]);
  if (row?.teams_user_id) return row.teams_user_id;
  const response = await graph(config, 'GET', `/users/${encodeURIComponent(user.email)}?$select=id`);
  if (response.status === 404) throw new Error(`No Microsoft 365 account has the address ${user.email}`);
  if (!response.ok) throw await graphError(response, `Looking up ${user.email} in Entra ID`, 'User.Read.All');
  const found = (await response.json()) as { id?: string };
  if (!found.id) throw new Error(`Entra ID returned no id for ${user.email}`);
  await db.run(`UPDATE users SET teams_user_id = ? WHERE id = ?`, [found.id, user.id]);
  return found.id;
}

export interface TeamsCallResult {
  status: 'sent' | 'failed' | 'skipped';
  provider: string;
  detail: string;
  externalId?: string;
}

/** Rings `user` in Teams. Never throws: the outcome is recorded on the attempt. */
export async function placeTeamsCall(user: PublicUser, attemptId: string): Promise<TeamsCallResult> {
  const settings = await getOpsSetting<StoredSettings>('teamsCalls', {});
  if (!settings.enabled) return { status: 'skipped', provider: 'teams', detail: 'Teams calls are turned off (On-call → Phone & SMS)' };
  const config = await botConfig();
  if (config.mode !== 'bot' || !config.appId || !config.appPassword || !config.tenantId) {
    return { status: 'failed', provider: 'teams', detail: 'The Teams integration needs bot mode with an app id, client secret and tenant id' };
  }
  const base = await publicBaseUrl();
  if (!base) return { status: 'failed', provider: 'teams', detail: 'Set an https App URL in Settings: Microsoft posts call events to it' };

  try {
    const objectId = await teamsUserIdFor(config, user);
    const response = await graph(config, 'POST', '/communications/calls', {
      '@odata.type': '#microsoft.graph.call',
      callbackUri: `${base}/api/webhooks/msteams/calling?attempt=${encodeURIComponent(attemptId)}`,
      targets: [
        {
          '@odata.type': '#microsoft.graph.invitationParticipantInfo',
          identity: {
            '@odata.type': '#microsoft.graph.identitySet',
            user: { '@odata.type': '#microsoft.graph.identity', displayName: user.name, id: objectId },
          },
        },
      ],
      requestedModalities: ['audio'],
      mediaConfig: { '@odata.type': '#microsoft.graph.serviceHostedMediaConfig' },
    });
    if (!response.ok) throw await graphError(response, 'Placing the Teams call', 'Calls.Initiate.All');
    const call = (await response.json()) as { id?: string };
    return { status: 'sent', provider: 'teams', detail: `Ringing ${user.name} in Teams`, externalId: call.id };
  } catch (error) {
    return { status: 'failed', provider: 'teams', detail: (error as Error).message };
  }
}

export async function hangUp(callId: string): Promise<void> {
  const config = await botConfig();
  if (!config.appId || !config.appPassword || !config.tenantId) return;
  const response = await graph(config, 'DELETE', `/communications/calls/${encodeURIComponent(callId)}`);
  // Already gone is the outcome wanted.
  if (!response.ok && response.status !== 404) throw await graphError(response, 'Hanging up', 'Calls.Initiate.All');
}

/** Once a page is acknowledged anywhere, stop any Teams call still ringing for it. */
export async function hangUpCallsForPage(pageId: string): Promise<void> {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const rows = await db.all<{ external_id: string }>(
    `SELECT external_id FROM notification_attempts
     WHERE page_id = ? AND channel = 'teams_call' AND status IN ('sent', 'answered') AND external_id IS NOT NULL AND created_at >= ?`,
    [pageId, since],
  );
  for (const row of rows) await hangUp(row.external_id).catch(() => undefined);
}

/* --------------------------- Call notifications --------------------------- */

interface CommsNotification {
  changeType?: string;
  resourceUrl?: string;
  resourceData?: { state?: string; toneInfo?: { tone?: string } } | unknown[];
}

interface AttemptRow {
  id: string;
  page_id: string | null;
  user_id: string;
  status: string;
  external_id: string | null;
}

async function setAttempt(id: string, status: string, detail?: string): Promise<void> {
  if (detail) await db.run(`UPDATE notification_attempts SET status = ?, detail = ? WHERE id = ?`, [status, detail.slice(0, 1000), id]);
  else await db.run(`UPDATE notification_attempts SET status = ? WHERE id = ?`, [status, id]);
}

/**
 * Handles one batch of call events from Microsoft. Establishing and
 * established can arrive out of order or twice, so every step is guarded by
 * the attempt's stored status rather than by the order things arrive in.
 */
export async function handleCallingNotifications(body: unknown, attemptHint: string | null): Promise<void> {
  const notifications = ((body as { value?: CommsNotification[] })?.value ?? []).slice(0, 20);
  const config = await botConfig();

  for (const notification of notifications) {
    const callId = /\/communications\/calls\/([^/?]+)$/.exec(notification.resourceUrl ?? '')?.[1];
    if (!callId) continue;
    const data = (Array.isArray(notification.resourceData) ? {} : notification.resourceData ?? {}) as { state?: string; toneInfo?: { tone?: string } };

    let attempt = await db.get<AttemptRow>(
      `SELECT id, page_id, user_id, status, external_id FROM notification_attempts WHERE channel = 'teams_call' AND external_id = ?`,
      [callId],
    );
    if (!attempt && attemptHint) {
      attempt = await db.get<AttemptRow>(
        `SELECT id, page_id, user_id, status, external_id FROM notification_attempts WHERE channel = 'teams_call' AND id = ?`,
        [attemptHint],
      );
      // The call id is only known once Graph answers the create request; an
      // early event can beat that, so it is attached here.
      if (attempt && !attempt.external_id) await db.run(`UPDATE notification_attempts SET external_id = ? WHERE id = ?`, [callId, attempt.id]);
    }
    if (!attempt) continue;

    if (notification.changeType === 'deleted' || data.state === 'terminated') {
      if (attempt.status === 'sent') await setAttempt(attempt.id, 'missed', 'Rang in Teams; not answered');
      continue;
    }

    if (data.toneInfo?.tone) {
      await handleTone(attempt, data.toneInfo.tone, callId);
      continue;
    }

    if (data.state === 'established' && attempt.status === 'sent') {
      const prompt = await promptUrl();
      if (!prompt) {
        // Answering alone does not acknowledge; hang up so the call does not sit silent.
        await setAttempt(attempt.id, 'answered', 'Answered in Teams. Acknowledge from the Teams card or the web to stop the escalation.');
        await hangUp(callId).catch(() => undefined);
        continue;
      }
      await setAttempt(attempt.id, 'answered', 'Answered in Teams; playing the prompt and waiting for a keypress');
      try {
        const subscribe = await graph(config, 'POST', `/communications/calls/${encodeURIComponent(callId)}/subscribeToTone`, { clientContext: attempt.id });
        if (!subscribe.ok) throw await graphError(subscribe, 'Listening for a keypress', 'Calls.AccessMedia.All');
        const play = await graph(config, 'POST', `/communications/calls/${encodeURIComponent(callId)}/playPrompt`, {
          clientContext: attempt.id,
          prompts: [
            {
              '@odata.type': '#microsoft.graph.mediaPrompt',
              mediaInfo: { '@odata.type': '#microsoft.graph.mediaInfo', uri: prompt, resourceId: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32) },
            },
          ],
        });
        if (!play.ok) throw await graphError(play, 'Playing the prompt', 'Calls.Initiate.All');
      } catch (error) {
        await setAttempt(attempt.id, 'answered', `Answered in Teams, but ${(error as Error).message}`);
      }
    }
  }
}

async function handleTone(attempt: AttemptRow, tone: string, callId: string): Promise<void> {
  // Imported here: the pager imports this module to place calls.
  const { acknowledgePage, escalateNow } = await import('./pager.ts');
  if (tone !== 'tone1' && tone !== 'tone2') return;
  /*
   * Microsoft can deliver a notification twice, and people press keys twice.
   * Claim the attempt with a marker only this delivery knows; whichever
   * delivery's marker is still there afterwards is the one that acts.
   */
  const claim = `tone:${crypto.randomUUID()}`;
  await db.run(`UPDATE notification_attempts SET status = ? WHERE id = ? AND status IN ('sent', 'answered')`, [claim, attempt.id]);
  const claimed = await db.get<{ status: string }>(`SELECT status FROM notification_attempts WHERE id = ?`, [attempt.id]);
  if (claimed?.status !== claim) return;
  const user = await findUserById(attempt.user_id);
  if (tone === 'tone1') {
    if (attempt.page_id && user) await acknowledgePage(attempt.page_id, user, 'msteams');
    await setAttempt(attempt.id, 'acknowledged', attempt.page_id ? 'Acknowledged by pressing 1 in Teams' : 'Pressed 1 in Teams (test call)');
    await hangUp(callId).catch(() => undefined);
  } else if (tone === 'tone2') {
    if (attempt.page_id && user) await escalateNow(attempt.page_id, user.name);
    await setAttempt(attempt.id, 'answered', 'Pressed 2 in Teams: escalated to the next level');
    await hangUp(callId).catch(() => undefined);
  }
}

/** Remembers the person's directory id when the Teams bot sees them. */
export async function rememberTeamsUserId(userId: string, aadObjectId: string | undefined): Promise<void> {
  if (!aadObjectId || !/^[0-9a-f-]{36}$/i.test(aadObjectId)) return;
  await db.run(`UPDATE users SET teams_user_id = ? WHERE id = ? AND (teams_user_id IS NULL OR teams_user_id <> ?)`, [aadObjectId, userId, aadObjectId]);
}
