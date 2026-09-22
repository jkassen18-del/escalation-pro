import { badRequest } from '../lib/http.ts';

/**
 * Which URLs a probe may be pointed at.
 *
 * Deliberately more permissive than the outbound-webhook guard, and for a
 * good reason: that one refuses private addresses because a webhook has no
 * business inside the network, whereas checking that the internal Jenkins
 * still answers is the entire point of a probe. Refusing 10.0.0.0/8 here
 * would make the feature useless for the on-premises deployment it is for.
 *
 * What stays blocked is the part that is never a legitimate health check and
 * is the actual prize in an SSRF: the cloud metadata endpoints, which hand
 * out instance credentials to anything that asks from the right place.
 */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
]);

/** Link-local, which is where every cloud keeps its instance metadata. */
function isLinkLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^fe80:/.test(host)) return true;
  // fd00:ec2::254 is the IPv6 metadata address on EC2.
  if (host === 'fd00:ec2::254') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 169 && b === 254;
}

export function assertProbeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('That is not a valid URL.', { url: 'Invalid URL' });
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('A probe URL must be http or https.', { url: 'Unsupported scheme' });
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || isLinkLocal(host)) {
    throw badRequest(
      'That address is a cloud metadata endpoint, which hands out instance credentials. It cannot be probed.',
      { url: 'Blocked host' },
    );
  }

  return url.toString();
}
