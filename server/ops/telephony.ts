import crypto from 'node:crypto';
import { config } from '../config.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';
import type { TelephonySettings } from '../../shared/ops.ts';

/**
 * SMS and voice.
 *
 * The default provider is the sandbox: nothing leaves the building, and each
 * attempt is recorded as "simulated" on the incident timeline, so a portable
 * evaluation can walk a whole escalation without a telephony account. Twilio
 * sends real messages and places real calls; its voice calls read the alert
 * and take a keypress (1 acknowledge, 2 escalate now, 3 hear the details).
 */

const DEFAULTS: TelephonySettings = { provider: 'sandbox', voiceRepeatMins: 2, voiceMaxCalls: 5 };

interface StoredTelephony extends Omit<TelephonySettings, 'authToken' | 'hasAuthToken'> {
  authTokenEncrypted?: string;
}

export async function loadTelephony(): Promise<TelephonySettings & { authToken?: string }> {
  const stored = await getOpsSetting<StoredTelephony>('telephony', DEFAULTS);
  const { authTokenEncrypted, ...rest } = stored;
  return { ...DEFAULTS, ...rest, authToken: authTokenEncrypted ? decryptSecret(authTokenEncrypted) : undefined };
}

/** For the API: the token never leaves the server. */
export async function publicTelephony(): Promise<TelephonySettings> {
  const { authToken, ...rest } = await loadTelephony();
  return { ...rest, hasAuthToken: Boolean(authToken) };
}

export async function saveTelephony(input: Partial<TelephonySettings>): Promise<TelephonySettings> {
  const current = await getOpsSetting<StoredTelephony>('telephony', DEFAULTS);
  const next: StoredTelephony = {
    ...current,
    provider: input.provider === 'twilio' ? 'twilio' : 'sandbox',
    accountSid: input.accountSid?.trim() || current.accountSid,
    fromNumber: input.fromNumber?.trim() || current.fromNumber,
    voiceRepeatMins: clamp(input.voiceRepeatMins ?? current.voiceRepeatMins, 1, 30),
    voiceMaxCalls: clamp(input.voiceMaxCalls ?? current.voiceMaxCalls, 1, 20),
  };
  if (input.authToken) next.authTokenEncrypted = encryptSecret(input.authToken.trim());
  await setOpsSetting('telephony', next);
  return publicTelephony();
}

function clamp(value: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export interface TelephonyResult {
  status: 'sent' | 'simulated' | 'failed';
  provider: string;
  detail: string;
  externalId?: string;
}

/** E.164, e.g. +27821234567. Spaces and dashes are forgiven. */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(cleaned) ? cleaned : null;
}

/* --------------------- Signed callback URLs for voice --------------------- */

/** A callback for one attempt, signed so a stranger cannot acknowledge a page by guessing ids. */
export function callbackToken(attemptId: string): string {
  return crypto.createHmac('sha256', config.secretKey).update(`voice:${attemptId}`).digest('hex').slice(0, 32);
}

export function verifyCallbackToken(attemptId: string, token: string): boolean {
  const expected = callbackToken(attemptId);
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function publicBaseUrl(): Promise<string | null> {
  const settings = await getSettings();
  const base = (settings.appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
  return /^https:\/\//.test(base) ? base : null;
}

/**
 * Twilio signs each webhook: HMAC-SHA1 of the full URL followed by every
 * POST parameter, sorted by name, keyed with the account's auth token.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export function voiceTwiml(message: string, gatherUrl: string | null): string {
  const say = `<Say voice="alice">${escapeXml(message)}</Say>`;
  if (!gatherUrl) return `<Response>${say}<Pause length="1"/>${say}</Response>`;
  const prompt = `<Say voice="alice">Press 1 to acknowledge. Press 2 to escalate now. Press 3 to hear the details.</Say>`;
  return `<Response><Gather numDigits="1" timeout="8" action="${escapeXml(gatherUrl)}" method="POST">${say}${prompt}</Gather>${say}</Response>`;
}

async function twilioPost(settings: TelephonySettings & { authToken?: string }, resource: string, form: Record<string, string>) {
  const auth = Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.accountSid!)}/${resource}.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Twilio answered HTTP ${response.status}`);
  return body;
}

export async function sendSms(to: string | null, message: string): Promise<TelephonyResult> {
  const settings = await loadTelephony();
  if (!to) return { status: 'failed', provider: settings.provider, detail: 'No valid phone number on this profile (use +27… format)' };
  if (settings.provider === 'sandbox') return { status: 'simulated', provider: 'sandbox', detail: `SMS to ${to}: ${message.slice(0, 140)}` };
  if (!settings.accountSid || !settings.authToken || !settings.fromNumber) {
    return { status: 'failed', provider: 'twilio', detail: 'Twilio is selected but not fully configured' };
  }
  try {
    const result = await twilioPost(settings, 'Messages', { To: to, From: settings.fromNumber, Body: message.slice(0, 1500) });
    return { status: 'sent', provider: 'twilio', detail: `SMS to ${to}`, externalId: result.sid };
  } catch (error) {
    return { status: 'failed', provider: 'twilio', detail: (error as Error).message };
  }
}

export async function placeCall(to: string | null, message: string, attemptId: string): Promise<TelephonyResult> {
  const settings = await loadTelephony();
  if (!to) return { status: 'failed', provider: settings.provider, detail: 'No valid phone number on this profile (use +27… format)' };
  if (settings.provider === 'sandbox') return { status: 'simulated', provider: 'sandbox', detail: `Call to ${to}: "${message.slice(0, 140)}"` };
  if (!settings.accountSid || !settings.authToken || !settings.fromNumber) {
    return { status: 'failed', provider: 'twilio', detail: 'Twilio is selected but not fully configured' };
  }
  const base = await publicBaseUrl();
  const gatherUrl = base ? `${base}/api/webhooks/telephony/twilio/voice?attempt=${attemptId}&t=${callbackToken(attemptId)}` : null;
  try {
    const result = await twilioPost(settings, 'Calls', { To: to, From: settings.fromNumber, Twiml: voiceTwiml(message, gatherUrl) });
    return {
      status: 'sent',
      provider: 'twilio',
      detail: gatherUrl ? `Calling ${to}` : `Calling ${to} (set an https App URL so the call can take an acknowledgement)`,
      externalId: result.sid,
    };
  } catch (error) {
    return { status: 'failed', provider: 'twilio', detail: (error as Error).message };
  }
}
