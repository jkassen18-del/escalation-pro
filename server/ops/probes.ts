import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { MonitorConfig, MonitorKind } from '../../shared/ops.ts';

/**
 * One check, of one target. Each probe resolves with a result and never
 * throws, so the scheduler can treat every kind the same way.
 *
 * Private and internal addresses are allowed on purpose: watching the
 * company's own intranet is most of the point, and only people holding
 * monitors.manage can create a monitor.
 */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function fail(message: string, latencyMs: number | null = null): ProbeResult {
  return { ok: false, latencyMs, message };
}

/** "200-299", "200,204,301" or "2xx". Empty means any 2xx or 3xx. */
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

async function probeHttp(target: string, config: MonitorConfig): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return fail(`"${target}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('Only http:// and https:// URLs can be checked');

  const started = Date.now();
  try {
    const method = config.method || 'GET';
    const response = await fetch(url, {
      method,
      headers: { 'User-Agent': 'InfraTicket-Monitor/2.0', ...(config.headers ?? {}) },
      body: method === 'POST' || method === 'PUT' ? config.body : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(config.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    const text = config.keyword ? await response.text() : (await response.arrayBuffer(), '');
    const latencyMs = Date.now() - started;

    if (!statusMatches(response.status, config.expectedStatus)) {
      return fail(`HTTP ${response.status} ${response.statusText}`.trim(), latencyMs);
    }
    if (config.keyword) {
      const found = text.includes(config.keyword);
      if (found === Boolean(config.keywordInverted)) {
        return fail(config.keywordInverted ? `Response contains "${config.keyword}"` : `"${config.keyword}" not found in the response`, latencyMs);
      }
    }
    if (config.maxResponseMs && latencyMs > config.maxResponseMs) {
      return fail(`Responded in ${latencyMs} ms, over the ${config.maxResponseMs} ms limit`, latencyMs);
    }
    return { ok: true, latencyMs, message: `HTTP ${response.status} in ${latencyMs} ms` };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if ((error as Error).name === 'TimeoutError') return fail(`No response within ${(config.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s`, latencyMs);
    return fail(cause?.code ? `${cause.code}: ${cause.message ?? ''}`.trim() : (error as Error).message, latencyMs);
  }
}

function splitHostPort(target: string, defaultPort?: number): { host: string; port: number } | null {
  const trimmed = target.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2] ?? defaultPort) };
  const index = trimmed.lastIndexOf(':');
  if (index > 0 && !trimmed.slice(0, index).includes(':')) {
    return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) };
  }
  return defaultPort ? { host: trimmed, port: defaultPort } : null;
}

function probeTcp(target: string, config: MonitorConfig): Promise<ProbeResult> {
  const address = splitHostPort(target);
  if (!address || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
    return Promise.resolve(fail('Give the target as host:port, e.g. db.internal:5432'));
  }
  const timeout = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: address.host, port: address.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(fail(`No answer from ${address.host}:${address.port} within ${timeout / 1000}s`, Date.now() - started));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      socket.destroy();
      resolve({ ok: true, latencyMs, message: `Port ${address.port} open, ${latencyMs} ms` });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve(fail(error.message, Date.now() - started));
    });
  });
}

/**
 * ICMP needs raw sockets, which need privileges a normal process does not
 * have - so this asks the system's own ping, which is installed setuid.
 */
function probePing(target: string, config: MonitorConfig): Promise<ProbeResult> {
  const host = target.trim();
  if (!/^[a-z0-9.:\-[\]]+$/i.test(host)) return Promise.resolve(fail('Give a hostname or IP address'));
  const timeoutSecs = Math.max(1, Math.round((config.timeoutMs || 5000) / 1000));
  const args = process.platform === 'win32' ? ['-n', '1', '-w', String(timeoutSecs * 1000), host] : ['-c', '1', '-W', String(timeoutSecs), host];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: (timeoutSecs + 2) * 1000, windowsHide: true }, (error, stdout) => {
      const elapsed = Date.now() - started;
      const time = /time[=<]\s*([\d.]+)\s*ms/i.exec(String(stdout));
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(fail('The ping command is not available on this server'));
        return resolve(fail(`${host} did not answer`, elapsed));
      }
      const latencyMs = time ? Math.round(Number(time[1])) : elapsed;
      resolve({ ok: true, latencyMs, message: `Reply from ${host} in ${latencyMs} ms` });
    });
  });
}

async function probeDns(target: string, config: MonitorConfig): Promise<ProbeResult> {
  const type = config.recordType || 'A';
  const started = Date.now();
  try {
    const records = await Promise.race([
      dns.resolve(target.trim(), type),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), config.timeoutMs || DEFAULT_TIMEOUT_MS)),
    ]);
    const latencyMs = Date.now() - started;
    const values = (records as unknown[]).map((record) =>
      typeof record === 'string' ? record : Array.isArray(record) ? record.join('') : (record as { exchange?: string }).exchange ?? JSON.stringify(record),
    );
    if (config.expectedValue && !values.some((value) => value.toLowerCase() === config.expectedValue!.toLowerCase())) {
      return fail(`${type} is ${values.join(', ') || 'empty'}, expected ${config.expectedValue}`, latencyMs);
    }
    return { ok: true, latencyMs, message: `${type} ${values.slice(0, 3).join(', ')}` };
  } catch (error) {
    return fail((error as Error).message, Date.now() - started);
  }
}

function probeSsl(target: string, config: MonitorConfig): Promise<ProbeResult> {
  const address = splitHostPort(target, 443);
  if (!address) return Promise.resolve(fail('Give a hostname, e.g. example.com or example.com:8443'));
  const warnDays = config.warnDays ?? 14;
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: address.host,
      port: address.port,
      servername: net.isIP(address.host) ? undefined : address.host,
      // Inspect the certificate even when it is invalid, to say why.
      rejectUnauthorized: false,
      timeout: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => {
      const latencyMs = Date.now() - started;
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const reason = socket.authorizationError;
      socket.end();
      if (!cert?.valid_to) return resolve(fail('No certificate presented', latencyMs));
      const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      if (!authorized) return resolve(fail(`Certificate not trusted: ${String(reason)}`, latencyMs));
      if (daysLeft < warnDays) {
        return resolve(fail(daysLeft < 0 ? `Certificate expired ${-daysLeft} days ago` : `Certificate expires in ${daysLeft} days`, latencyMs));
      }
      resolve({ ok: true, latencyMs, message: `Certificate valid for ${daysLeft} more days` });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(fail('TLS handshake timed out', Date.now() - started));
    });
    socket.once('error', (error) => resolve(fail(error.message, Date.now() - started)));
  });
}

export async function runProbe(kind: MonitorKind, target: string, config: MonitorConfig): Promise<ProbeResult> {
  switch (kind) {
    case 'http':
      return probeHttp(target, config);
    case 'tcp':
      return probeTcp(target, config);
    case 'ping':
      return probePing(target, config);
    case 'dns':
      return probeDns(target, config);
    case 'ssl':
      return probeSsl(target, config);
    default:
      return fail(`${kind} monitors are not probed directly`);
  }
}
