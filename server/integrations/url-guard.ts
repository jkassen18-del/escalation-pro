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

function isPrivateAddress(hostname: string): boolean {
  // IPv6 loopback and unique-local / link-local ranges.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
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
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || isPrivateAddress(host)) {
    throw badRequest(`${field} cannot point at a private or internal address.`, { [field]: 'Blocked host' });
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
