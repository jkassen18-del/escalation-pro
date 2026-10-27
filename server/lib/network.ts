import net from 'node:net';
import type { Request } from 'express';

/**
 * Who is really on the other end of a request, and whether they are on the
 * company network.
 *
 * Behind a Cloudflare Tunnel every request reaches the app from cloudflared on
 * the same machine, so the socket address is always loopback. Cloudflare puts
 * the visitor's real address in CF-Connecting-IP and overwrites any value the
 * visitor sent, so that header is believed - but only when the request came
 * from this machine. Anyone connecting directly cannot use it to pretend.
 */

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

const normalise = (address: string) => address.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

export function isLoopback(address: string | null | undefined): boolean {
  return Boolean(address && LOOPBACK.test(address));
}

/** The visitor's address: Cloudflare's report when relayed locally, else Express's view (which honours trust proxy). */
export function clientAddress(req: Request): string | null {
  const socket = req.socket?.remoteAddress ?? null;
  const relayed = req.get('cf-connecting-ip');
  if (relayed && isLoopback(socket) && net.isIP(relayed.trim())) return normalise(relayed);
  const address = req.ip ?? socket;
  return address ? normalise(address) : null;
}

/** True when the request was made on this machine itself, with no proxy in between. */
export function isDirectLocal(req: Request): boolean {
  return isLoopback(req.socket?.remoteAddress) && !req.get('cf-connecting-ip') && !req.get('x-forwarded-for');
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
