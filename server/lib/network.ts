import net from 'node:net';
import type { Request } from 'express';

/**
 * Who is really on the other end of a request, and whether they are on the
 * company network - however the app is reached: directly, through a reverse
 * proxy (IIS, nginx, Caddy) or through a tunnel (Cloudflare and others).
 *
 * By default the address comes from Express, which believes X-Forwarded-For
 * only from proxies TRUST_PROXY names (the portable exe: a proxy on this
 * machine). CLIENT_IP_HEADER names a proxy's own header instead, such as
 * cf-connecting-ip for Cloudflare or x-real-ip for nginx; it too is believed
 * only when the request came from a trusted proxy, so someone connecting
 * directly cannot use it to pretend to be on the company network.
 */

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded'];

const normalise = (address: string) => address.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

export function isLoopback(address: string | null | undefined): boolean {
  return Boolean(address && LOOPBACK.test(address));
}

function fromTrustedProxy(req: Request): boolean {
  const trust = req.app?.get('trust proxy fn') as ((address: string, hop: number) => boolean) | undefined;
  const socket = req.socket?.remoteAddress;
  return Boolean(trust && socket && trust(socket, 0));
}

/** The visitor's address, as the configured proxy reports it, or as Express sees it. */
export function clientAddress(req: Request): string | null {
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header && fromTrustedProxy(req)) {
    const reported = req.get(header)?.split(',')[0]?.trim();
    if (reported && net.isIP(reported)) return normalise(reported);
  }
  const address = req.ip ?? req.socket?.remoteAddress ?? null;
  return address ? normalise(address) : null;
}

/** True when the request was made on this machine itself, with no proxy in between. */
export function isDirectLocal(req: Request): boolean {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  return isLoopback(req.socket?.remoteAddress) && ![...PROXY_HEADERS, ...(configured ? [configured] : [])].some((name) => req.get(name));
}

export interface NetworkPolicy {
  /** Empty: no restriction (the default, so existing installs keep working). */
  ranges: string[];
  list: net.BlockList | null;
}

/** Parses "10.0.0.0/8, 196.22.10.4, 2001:db8::/32" into a policy; throws on a malformed entry. */
export function parseNetworks(value: string | undefined): NetworkPolicy {
  const ranges = (value ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!ranges.length) return { ranges, list: null };
  const list = new net.BlockList();
  for (const range of ranges) {
    const [address, bits] = range.split('/');
    const family = net.isIP(address);
    if (!family) throw new Error(`ALLOWED_NETWORKS: "${range}" is not an IP address or CIDR range`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`ALLOWED_NETWORKS: "${range}" has an invalid prefix`);
      list.addSubnet(address, prefix, type);
    }
  }
  return { ranges, list };
}

export function isAllowed(policy: NetworkPolicy, address: string | null): boolean {
  if (!policy.list) return true;
  if (!address) return false;
  const family = net.isIP(address);
  if (!family) return false;
  return policy.list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
