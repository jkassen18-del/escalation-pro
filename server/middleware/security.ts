import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SESSION_COOKIE_NAME } from '../config.ts';
import { clientAddress, isAllowed, isDirectLocal, parseNetworks, type NetworkPolicy } from '../lib/network.ts';

/**
 * The app's outer wall. Everything here runs before routing:
 *
 * - security headers on every response (no framing, no sniffing, a strict
 *   content policy, no indexing, HSTS over https);
 * - an optional company-network allowlist (ALLOWED_NETWORKS) that turns away
 *   everyone else before they see so much as the login page;
 * - a same-origin check on every state-changing request made with the session
 *   cookie, so another site cannot make a signed-in browser act;
 * - per-address request limits, so the API cannot be hammered or crawled.
 */

/* --------------------------------- Headers -------------------------------- */

const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React and the flow canvas set inline style attributes; styles cannot run code.
  "style-src 'self' 'unsafe-inline'",
  // Pasted screenshots are data: and blob: URLs; a logo may be hosted elsewhere.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders({ production }: { production: boolean }): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // An internal tool: nothing here belongs in a search engine.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    // The dev server injects inline scripts for hot reload; the policy is for the built app.
    if (production) res.setHeader('Content-Security-Policy', CONTENT_POLICY);
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // API answers carry tickets and people: never kept by a browser cache or a CDN.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export const robotsTxt: RequestHandler = (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
};

/* ----------------------------- Network allowlist ----------------------------- */

/**
 * Paths outside services must reach even when the app is closed to the
 * internet. Each carries its own proof: Slack, Teams, GitHub and Linear sign
 * their requests, and alert sources and heartbeats use secret URLs.
 */
export const DEFAULT_PUBLIC_PATHS = ['/api/webhooks/', '/api/ingest/', '/api/heartbeat/'];

export function publicPaths(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return DEFAULT_PUBLIC_PATHS;
  if (value.trim().toLowerCase() === 'none') return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/'));
}

export function networkGuard(policy: NetworkPolicy, open: string[]): RequestHandler {
  return (req, res, next) => {
    if (!policy.list) return next();
    // On the server itself (an administrator, a local health check): always allowed.
    if (isDirectLocal(req)) return next();
    if (open.some((prefix) => req.path.startsWith(prefix))) return next();
    if (isAllowed(policy, clientAddress(req))) return next();
    // Nothing about the app is given away: no login page, no assets, no version.
    res.status(403).type('text/plain').send('This service is only available on the company network.');
  };
}

export function networkPolicyFromEnv(): NetworkPolicy {
  return parseNetworks(process.env.ALLOWED_NETWORKS);
}

/* --------------------------- Same-origin (CSRF) check --------------------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Signed or token-authenticated entry points that legitimately arrive from other origins. */
const CROSS_ORIGIN_OK = ['/api/webhooks/', '/api/ingest/', '/api/heartbeat/', '/api/auth/saml', '/api/cron', '/mcp', '/oauth/'];

const hostOf = (value: string | undefined | null) => {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * A state-changing request made with the session cookie must come from one of
 * the app's own pages. The cookie is already SameSite=Lax; this is the second
 * lock, and it also covers same-site subdomains Lax would let through.
 */
export function sameOriginGuard(appUrl: () => string | undefined): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!req.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`)) return next();
    if (CROSS_ORIGIN_OK.some((prefix) => req.path.startsWith(prefix))) return next();

    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site') return refuse(res);
    const origin = hostOf(req.get('origin')) ?? hostOf(req.get('referer'));
    // Browsers always send Origin on these requests; a script or tool without one is not a browser being tricked.
    if (!origin) return next();
    const own = new Set(
      [req.get('host'), req.get('x-forwarded-host'), hostOf(appUrl()), hostOf(process.env.APP_URL)]
        .filter((host): host is string => Boolean(host))
        .map((host) => host.toLowerCase()),
    );
    if (own.has(origin)) return next();
    return refuse(res);
  };
}

function refuse(res: Response) {
  res.status(403).json({ error: 'This request came from another site and was refused.' });
}

/* ------------------------------- Request limits ------------------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed one-minute windows per address. Generous enough for an office behind
 * one address, tight enough that scripted crawling or flooding stalls fast.
 */
export function requestLimiter(rules: Array<{ prefix: string; perMinute: number; name: string }>): RequestHandler & { reset: () => void } {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, 60_000);
  sweep.unref();

  const handler = ((req: Request, res: Response, next: NextFunction) => {
    if (isDirectLocal(req)) return next();
    const rule = rules.find((candidate) => req.path.startsWith(candidate.prefix));
    if (!rule) return next();
    const key = `${rule.name}:${clientAddress(req) ?? 'unknown'}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rule.perMinute) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    }
    next();
  }) as RequestHandler & { reset: () => void };
  handler.reset = () => buckets.clear();
  return handler;
}

export const LIMIT_RULES = [
  // Unauthenticated ways in: sign-in, invites, alert intake.
  { name: 'auth', prefix: '/api/auth/', perMinute: Number(process.env.RATE_LIMIT_AUTH_PER_MIN || 300) },
  { name: 'invite', prefix: '/api/invite', perMinute: 60 },
  { name: 'intake', prefix: '/api/ingest/', perMinute: Number(process.env.RATE_LIMIT_INTAKE_PER_MIN || 600) },
  { name: 'intake', prefix: '/api/heartbeat/', perMinute: 600 },
  { name: 'intake', prefix: '/api/webhooks/', perMinute: Number(process.env.RATE_LIMIT_INTAKE_PER_MIN || 600) },
  // Everything else, per address (an office shares one).
  { name: 'api', prefix: '/api/', perMinute: Number(process.env.RATE_LIMIT_API_PER_MIN || 3000) },
];
