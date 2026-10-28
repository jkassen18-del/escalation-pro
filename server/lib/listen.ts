import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import type { Express } from 'express';

/**
 * How InfraTicket is served, chosen in .env rather than fixed:
 *
 * - plain http (the default), on this computer only (HOST=127.0.0.1) or on
 *   the whole network (HOST=0.0.0.0);
 * - https with the organisation's own certificate, with no proxy or tunnel:
 *   TLS_PFX_FILE (+ TLS_PFX_PASSPHRASE), the .pfx Windows and IT teams
 *   usually hand out, or TLS_CERT_FILE + TLS_KEY_FILE as PEM;
 * - behind any reverse proxy or tunnel (IIS, nginx, Caddy, Azure Application
 *   Proxy, Cloudflare), which terminates https itself.
 */

export interface TlsOptions {
  pfx?: Buffer;
  passphrase?: string;
  cert?: Buffer;
  key?: Buffer;
}

/** The certificate from the environment, or null for plain http. Throws with the file's name when one is set but unreadable. */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): TlsOptions | null {
  const read = (variable: string) => {
    const file = env[variable];
    if (!file) return undefined;
    try {
      return fs.readFileSync(file);
    } catch (error) {
      throw new Error(`${variable}: cannot read ${file} (${(error as Error).message})`);
    }
  };
  if (env.TLS_PFX_FILE) return { pfx: read('TLS_PFX_FILE'), passphrase: env.TLS_PFX_PASSPHRASE || undefined };
  if (env.TLS_CERT_FILE || env.TLS_KEY_FILE) {
    if (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or TLS_PFX_FILE.');
    return { cert: read('TLS_CERT_FILE'), key: read('TLS_KEY_FILE') };
  }
  return null;
}

export function createListener(app: Express, tls: TlsOptions | null): http.Server {
  return tls ? https.createServer({ ...tls, minVersion: 'TLSv1.2' }, app) : http.createServer(app);
}

/** The addresses people can type in, for the startup message. */
export function reachableUrls(host: string, port: number, secure: boolean): string[] {
  const scheme = secure ? 'https' : 'http';
  const everywhere = host === '0.0.0.0' || host === '::' || host === '';
  if (!everywhere) return [`${scheme}://${host === '127.0.0.1' || host === '::1' ? 'localhost' : host}:${port}`];
  const urls = [`${scheme}://localhost:${port}`, `${scheme}://${os.hostname()}:${port}`];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) urls.push(`${scheme}://${address.address}:${port}`);
    }
  }
  return urls;
}
