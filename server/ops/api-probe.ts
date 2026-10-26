import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { assertOutboundUrl, assertResolvesSafely } from '../integrations/url-guard.ts';
import { assertSafeRegex } from './routing.ts';
import {
  ASSERTION_OPS,
  ASSERTION_OP_LABELS,
  ASSERTION_SOURCES,
  HTTP_METHODS,
  type ApiAssertion,
  type ApiAuth,
  type ApiTryResult,
  type AssertionResult,
  type MonitorConfig,
} from '../../shared/ops.ts';

/**
 * API monitoring: one HTTP request built from a monitor's settings, and the
 * checks that judge its response. Used by the scheduler on every run and by
 * "Send request" in the editor, so what is tried is exactly what is monitored.
 */

const MAX_BODY = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SECRET_FIELDS = ['token', 'password', 'keyValue'] as const;
const ENCRYPTED = 'enc:';

/* --------------------------------- Secrets --------------------------------- */

/**
 * Before storing: encrypt new secrets, and keep the stored ones where the
 * editor sent a blank (it never receives them, so blank means "unchanged").
 */
export function sealAuth(next: ApiAuth | undefined, previous: ApiAuth | undefined): ApiAuth | undefined {
  if (!next || next.type === 'none') return next?.type === 'none' ? { type: 'none' } : undefined;
  const sealed: ApiAuth = { type: next.type, username: next.username, keyName: next.keyName, keyIn: next.keyIn };
  for (const field of SECRET_FIELDS) {
    const value = next[field];
    if (value) sealed[field] = value.startsWith(ENCRYPTED) ? value : `${ENCRYPTED}${encryptSecret(value)}`;
    else if (previous?.type === next.type && previous[field]) sealed[field] = previous[field];
  }
  return sealed;
}

/** For the browser: secrets removed, with a flag saying one is stored. */
export function maskAuth(auth: ApiAuth | undefined): ApiAuth | undefined {
  if (!auth) return auth;
  const secretSet = SECRET_FIELDS.some((field) => Boolean(auth[field]));
  const { token: _t, password: _p, keyValue: _k, ...rest } = auth;
  return { ...rest, secretSet };
}

function reveal(value: string | undefined): string {
  if (!value) return '';
  if (!value.startsWith(ENCRYPTED)) return value;
  try {
    return decryptSecret(value.slice(ENCRYPTED.length));
  } catch {
    return '';
  }
}

/* --------------------------------- Request --------------------------------- */

export function validateApiConfig(config: MonitorConfig): MonitorConfig {
  const method = HTTP_METHODS.includes(config.method as never) ? config.method : 'GET';
  const strings = (value: unknown) =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key.trim())
            .slice(0, 50)
            .map(([key, item]) => [key.trim().slice(0, 200), String(item ?? '').slice(0, 4000)]),
        )
      : undefined;
  const assertions = Array.isArray(config.assertions)
    ? config.assertions
        .filter((item) => item && ASSERTION_SOURCES.includes(item.source) && ASSERTION_OPS.includes(item.op))
        .slice(0, 30)
        .map((item) => ({
          source: item.source,
          op: item.op,
          path: item.path ? String(item.path).slice(0, 300) : undefined,
          value: item.value !== undefined && item.value !== null ? String(item.value).slice(0, 1000) : undefined,
        }))
    : undefined;
  // A pattern is run against up to 64 KB on every check: refuse the shapes that backtrack forever.
  for (const assertion of assertions ?? []) if (assertion.op === 'matches') assertSafeRegex(assertion.value ?? '');
  const auth = config.auth && ['none', 'bearer', 'basic', 'apikey'].includes(config.auth.type) ? config.auth : undefined;
  return {
    ...config,
    method,
    body: config.body ? String(config.body).slice(0, 100_000) : undefined,
    bodyType: ['none', 'json', 'text', 'form'].includes(config.bodyType ?? '') ? config.bodyType : undefined,
    query: strings(config.query),
    headers: strings(config.headers),
    auth,
    assertions,
    followRedirects: config.followRedirects !== false,
  };
}

function buildRequest(target: string, config: MonitorConfig): { url: URL; init: RequestInit } {
  const url = new URL(target);
  for (const [key, value] of Object.entries(config.query ?? {})) url.searchParams.set(key, value);

  const headers = new Headers({ 'User-Agent': 'InfraTicket-Monitor/2.0', Accept: 'application/json, text/plain, */*' });
  for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, value);

  const auth = config.auth;
  if (auth?.type === 'bearer' && auth.token) headers.set('Authorization', `Bearer ${reveal(auth.token)}`);
  if (auth?.type === 'basic') headers.set('Authorization', `Basic ${Buffer.from(`${auth.username ?? ''}:${reveal(auth.password)}`).toString('base64')}`);
  if (auth?.type === 'apikey' && auth.keyName) {
    if (auth.keyIn === 'query') url.searchParams.set(auth.keyName, reveal(auth.keyValue));
    else headers.set(auth.keyName, reveal(auth.keyValue));
  }

  const method = config.method || 'GET';
  const sendsBody = !['GET', 'HEAD'].includes(method) && config.body && config.bodyType !== 'none';
  if (sendsBody && !headers.has('Content-Type')) {
    const type = config.bodyType === 'form' ? 'application/x-www-form-urlencoded' : config.bodyType === 'text' ? 'text/plain' : config.bodyType === 'json' ? 'application/json' : null;
    if (type) headers.set('Content-Type', type);
  }

  return {
    url,
    init: {
      method,
      headers,
      body: sendsBody ? config.body : undefined,
      redirect: config.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(config.timeoutMs || DEFAULT_TIMEOUT_MS),
    },
  };
}

/* -------------------------------- Assertions -------------------------------- */

/** Reads data.items[0].status, $.a.b, items.length or items[-1] from parsed JSON. */
export function readPath(value: unknown, path: string): { found: boolean; value: unknown } {
  const tokens = path
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(-?\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = value;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (token === 'length') {
        current = current.length;
        continue;
      }
      const index = Number(token);
      if (!Number.isInteger(index)) return { found: false, value: undefined };
      const resolved = index < 0 ? current.length + index : index;
      if (resolved < 0 || resolved >= current.length) return { found: false, value: undefined };
      current = current[resolved];
    } else if (current && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[token];
    } else if (typeof current === 'string' && token === 'length') {
      current = current.length;
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

const asText = (value: unknown) => (value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value));

export interface ApiResponseFacts {
  status: number;
  latencyMs: number;
  headers: Headers;
  body: string;
  json: unknown;
}

export function describeAssertion(assertion: ApiAssertion): string {
  const subject =
    assertion.source === 'status'
      ? 'Status'
      : assertion.source === 'latency'
        ? 'Response time (ms)'
        : assertion.source === 'body'
          ? 'Body'
          : assertion.source === 'header'
            ? `Header ${assertion.path ?? ''}`
            : assertion.path || '(whole JSON)';
  const op = ASSERTION_OP_LABELS[assertion.op];
  return ['exists', 'not_exists'].includes(assertion.op) ? `${subject} ${op}` : `${subject} ${op} ${assertion.value ?? ''}`.trim();
}

export function evaluateAssertion(assertion: ApiAssertion, facts: ApiResponseFacts): AssertionResult {
  let found = true;
  let actual: unknown;
  switch (assertion.source) {
    case 'status':
      actual = facts.status;
      break;
    case 'latency':
      actual = facts.latencyMs;
      break;
    case 'body':
      actual = facts.body;
      break;
    case 'header': {
      const header = facts.headers.get(assertion.path ?? '');
      found = header !== null;
      actual = header ?? undefined;
      break;
    }
    case 'json': {
      if (facts.json === undefined) {
        found = false;
        break;
      }
      const read = assertion.path ? readPath(facts.json, assertion.path) : { found: true, value: facts.json };
      found = read.found;
      actual = read.value;
      break;
    }
  }

  const text = found ? asText(actual) : null;
  const expected = assertion.value ?? '';
  const asNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
  let ok: boolean;
  switch (assertion.op) {
    case 'exists':
      ok = found && actual !== null;
      break;
    case 'not_exists':
      ok = !found || actual === null;
      break;
    case 'eq':
      ok = found && (text === expected || (typeof actual !== 'string' && asNumber(actual) === asNumber(expected) && !Number.isNaN(asNumber(expected))));
      break;
    case 'neq':
      ok = !found || !(text === expected || (typeof actual !== 'string' && asNumber(actual) === asNumber(expected)));
      break;
    case 'contains':
      ok = found && text !== null && text.toLowerCase().includes(expected.toLowerCase());
      break;
    case 'not_contains':
      ok = !found || text === null || !text.toLowerCase().includes(expected.toLowerCase());
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      ok =
        found &&
        !Number.isNaN(a) &&
        !Number.isNaN(b) &&
        (assertion.op === 'gt' ? a > b : assertion.op === 'gte' ? a >= b : assertion.op === 'lt' ? a < b : a <= b);
      break;
    }
    case 'matches':
      try {
        ok = found && text !== null && assertSafeRegex(expected).test(text);
      } catch {
        ok = false;
      }
      break;
  }

  const shown = text === null ? 'missing' : text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return {
    assertion,
    ok,
    actual: text,
    message: ok ? `${describeAssertion(assertion)} ✓ (${shown})` : `${describeAssertion(assertion)}, but it was ${shown}`,
  };
}

/* --------------------------------- The call --------------------------------- */

/** Status ranges: "200-299", "200,204,301" or "2xx". Empty means any 2xx or 3xx. */
export function statusMatches(status: number, expected?: string): boolean {
  const spec = (expected || '200-399').replace(/\s/g, '');
  return spec.split(',').some((part) => {
    if (/^\dxx$/i.test(part)) return Math.floor(status / 100) === Number(part[0]);
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      return status >= lo && status <= hi;
    }
    return status === Number(part);
  });
}

/** Makes the request and judges it. Never throws. */
export async function callApi(target: string, config: MonitorConfig): Promise<ApiTryResult> {
  const empty = { status: null, statusText: '', latencyMs: null, headers: {}, contentType: null, body: '', truncated: false, json: undefined, assertions: [], url: target };
  let request: ReturnType<typeof buildRequest>;
  try {
    request = buildRequest(target, config);
  } catch {
    return { ...empty, ok: false, message: `"${target}" is not a URL` };
  }
  if (request.url.protocol !== 'http:' && request.url.protocol !== 'https:') {
    return { ...empty, ok: false, message: 'Only http:// and https:// URLs can be checked' };
  }

  const started = Date.now();
  let response: Response;
  let raw = '';
  try {
    /*
     * Redirects are followed by hand so every hop is checked: internal
     * services may be monitored, but no hop may reach a cloud metadata or
     * link-local address, by name or by what the name resolves to.
     */
    let hop = request.url;
    for (let redirects = 0; ; redirects += 1) {
      assertOutboundUrl(hop.toString(), 'URL', { allowPrivate: true });
      await assertResolvesSafely(hop.toString(), { allowPrivate: true });
      response = await fetch(hop, { ...request.init, redirect: 'manual' });
      const location = response.headers.get('location');
      if (config.followRedirects === false || response.status < 300 || response.status >= 400 || !location || redirects >= 5) break;
      await response.body?.cancel().catch(() => undefined);
      hop = new URL(location, hop);
      // A 303, or a 301/302 after a POST, becomes a GET without a body, as browsers do.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.init.method === 'POST')) {
        request.init = { ...request.init, method: 'GET', body: undefined };
      }
    }
    // Read at most 64 KB plus a little: enough to judge, never a whole download.
    if (request.init.method !== 'HEAD' && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size <= MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      await reader.cancel().catch(() => undefined);
      raw = Buffer.concat(chunks).toString('utf8');
    }
  } catch (error) {
    const latencyMs = Date.now() - started;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const message =
      (error as Error).name === 'TimeoutError'
        ? `No response within ${(config.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s`
        : cause?.code
          ? `${cause.code}: ${cause.message ?? ''}`.trim()
          : (error as Error).message;
    return { ...empty, ok: false, latencyMs, message: message || 'The request failed', url: request.url.toString() };
  }

  const latencyMs = Date.now() - started;
  const truncated = raw.length > MAX_BODY;
  const body = truncated ? raw.slice(0, MAX_BODY) : raw;
  const contentType = response.headers.get('content-type');
  let json: unknown;
  if (body && (contentType?.includes('json') || /^\s*[[{]/.test(body))) {
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
  }

  const facts: ApiResponseFacts = { status: response.status, latencyMs, headers: response.headers, body, json };
  const assertions = (config.assertions ?? []).map((assertion) => evaluateAssertion(assertion, facts));
  const failures: string[] = [];
  if (!statusMatches(response.status, config.expectedStatus)) failures.push(`HTTP ${response.status} ${response.statusText}`.trim());
  if (config.keyword) {
    const found = body.includes(config.keyword);
    if (found === Boolean(config.keywordInverted)) failures.push(config.keywordInverted ? `Response contains "${config.keyword}"` : `"${config.keyword}" not found in the response`);
  }
  if (config.maxResponseMs && latencyMs > config.maxResponseMs) failures.push(`Responded in ${latencyMs} ms, over the ${config.maxResponseMs} ms limit`);
  failures.push(...assertions.filter((result) => !result.ok).map((result) => result.message));

  // On success the message carries the watched values, so the history shows them.
  const watched = assertions
    .filter((result) => result.assertion.source === 'json' && result.actual !== null)
    .slice(0, 3)
    .map((result) => `${result.assertion.path} = ${result.actual!.length > 40 ? `${result.actual!.slice(0, 40)}…` : result.actual}`);

  return {
    ok: failures.length === 0,
    message: failures.length ? failures.join('; ').slice(0, 500) : [`HTTP ${response.status} in ${latencyMs} ms`, ...watched].join(' · '),
    status: response.status,
    statusText: response.statusText,
    latencyMs,
    headers: (() => {
      const all: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        all[key] = value;
      });
      return all;
    })(),
    contentType,
    body,
    truncated,
    json,
    assertions,
    url: request.url.toString(),
  };
}
