import { badRequest } from '../lib/http.ts';

/**
 * Outbound webhook URLs are attacker-useful even though only administrators can
 * set them: a URL pointing at localhost or cloud metadata turns the server into
 * a proxy for internal services (SSRF). These checks keep an admin mistake, or
 * a compromised admin session, from reaching inside the network.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * The host as it will actually be connected to: brackets and a trailing dot
 * removed, and an IPv4-mapped IPv6 address ([::ffff:127.0.0.1], which the URL
 * parser rewrites to [::ffff:7f00:1]) turned back into the IPv4 it stands for.
 */
export function canonicalHost(hostname: string): string {
  let host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(host) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) host = rest;
    else {
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      }
    }
  }
  return host;
}

function isLinkLocal(host: string): boolean {
  return /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host.startsWith('metadata.') || BLOCKED_HOSTNAMES.has(host) && host !== 'localhost' && host !== 'localhost.localdomain';
}

export function isPrivateAddress(hostname: string): boolean {
  // IPv6 loopback and unique-local / link-local ranges.
  const host = canonicalHost(hostname);
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export function assertSafeWebhookUrl(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`${field} must be a valid URL.`, { [field]: 'Invalid URL' });
  }

  if (url.protocol !== 'https:') {
    throw badRequest(`${field} must use https.`, { [field]: 'HTTPS required' });
  }
  const host = canonicalHost(url.hostname);
  if (BLOCKED_HOSTNAMES.has(host) || isPrivateAddress(host)) {
    throw badRequest(`${field} cannot point at a private or internal address.`, { [field]: 'Blocked host' });
  }
  return url.toString();
}

/**
 * For integrations an administrator points at their own systems.
 *
 * With `allowPrivate` off this is the webhook guard above. With it on, plain
 * http and private addresses are accepted - the integration exists to reach
 * an internal service - but link-local and the cloud metadata hostnames stay
 * blocked: no internal system is legitimately reached through them, and they
 * are where an SSRF does its damage.
 */
export function assertOutboundUrl(raw: string, field: string, { allowPrivate = false } = {}): string {
  if (!allowPrivate) return assertSafeWebhookUrl(raw, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`${field} must be a valid URL.`, { [field]: 'Invalid URL' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest(`${field} must use http or https.`, { [field]: 'Unsupported scheme' });
  }
  const host = canonicalHost(url.hostname);
  if (isLinkLocal(host)) {
    throw badRequest(`${field} cannot point at a link-local or cloud metadata address.`, { [field]: 'Blocked host' });
  }
  return url.toString();
}

/** Slack publishes exactly one incoming-webhook host, so pin it. */
export function assertSlackWebhookUrl(raw: string): string {
  const url = assertSafeWebhookUrl(raw, 'Webhook URL');
  if (new URL(url).hostname.toLowerCase() !== 'hooks.slack.com') {
    throw badRequest('A Slack incoming webhook URL must be on hooks.slack.com.', {
      webhookUrl: 'Not a Slack webhook',
    });
  }
  return url;
}

/**
 * The literal-host checks above cannot see a public name that resolves to a
 * private address (127.0.0.1.nip.io). This resolves the name and checks every
 * address it gives, just before connecting.
 */
export async function assertResolvesSafely(raw: string, { allowPrivate = false } = {}): Promise<void> {
  const { lookup } = await import('node:dns/promises');
  const host = canonicalHost(new URL(raw).hostname);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return; // An unresolvable name fails on its own when fetched.
  }
  for (const { address } of addresses) {
    const canonical = canonicalHost(address);
    if (isLinkLocal(canonical) || (!allowPrivate && isPrivateAddress(canonical))) {
      throw badRequest(`${host} resolves to ${address}, a ${allowPrivate ? 'link-local or metadata' : 'private or internal'} address.`);
    }
  }
}
