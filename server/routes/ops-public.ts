import express, { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../lib/http.ts';
import { getSettings } from '../repositories/settings.ts';
import { attachUser, type AuthedRequest } from '../middleware/auth.ts';
import { ingestSignal } from '../ops/alerts.ts';
import { recordHeartbeat } from '../ops/monitors.ts';
import { acknowledgePage, attemptContext, escalateNow, markAttemptAnswered, pageForPhone } from '../ops/pager.ts';
import { confirmSnsSubscription, noteSourceEvent, normalise, sourceByToken, verifySnsMessage } from '../ops/sources.ts';
import { getStatusPage, renderStatusPage, statusPageHtml } from '../ops/status-pages.ts';
import { escapeXml, loadTelephony, normalisePhone, publicBaseUrl, twilioSignature, verifyCallbackToken, voiceTwiml } from '../ops/telephony.ts';
import { timingSafeCompare } from '../lib/crypto.ts';

/**
 * Endpoints reached by machines and the public, not by signed-in people.
 * Each one carries its own proof: a secret in the URL, a provider signature,
 * or - for status pages - nothing, because a public page is public.
 */
export const opsPublicRouter: Router = Router();

/* ------------------------------ Alert intake ------------------------------ */

// SNS posts JSON as text/plain, and some tools send no content type at all.
const anyText = express.text({ type: (req) => !String(req.headers['content-type'] ?? '').includes('json'), limit: '1mb' });

opsPublicRouter.post(
  '/api/ingest/:token',
  anyText,
  asyncRoute(async (req, res) => {
    const source = await sourceByToken(req.params.token);
    if (!source || !source.enabled) return res.status(404).json({ error: 'Unknown alert source' });

    let payload: Record<string, unknown>;
    if (typeof req.body === 'string') {
      try {
        payload = req.body.trim() ? JSON.parse(req.body) : {};
      } catch {
        payload = { title: req.body.slice(0, 200), message: req.body };
      }
    } else {
      payload = (req.body ?? {}) as Record<string, unknown>;
    }
    if (Array.isArray(payload)) payload = { alerts: payload };

    if (source.kind === 'aws_sns' && typeof payload.Type === 'string') {
      const message = payload as Record<string, string>;
      if (!(await verifySnsMessage(message))) return res.status(403).json({ error: 'The SNS signature did not verify' });
      if (message.Type === 'SubscriptionConfirmation') {
        const confirmed = await confirmSnsSubscription(message);
        return res.status(confirmed ? 200 : 502).json({ confirmed });
      }
      if (message.Type === 'UnsubscribeConfirmation') return res.json({ ok: true });
    }

    await noteSourceEvent(source.id);
    const results = [];
    for (const signal of normalise(source, payload)) {
      results.push(
        await ingestSignal({
          ...signal,
          sourceType: 'webhook',
          sourceId: source.id,
          sourceName: source.name,
          teamId: source.teamId,
          escalationPolicyId: source.escalationPolicyId,
        }),
      );
    }
    res.status(202).json({ accepted: results.length, results: results.map(({ action, ticketId }) => ({ action, ticketId })) });
  }),
);

/* ------------------------------- Heartbeats ------------------------------- */

const heartbeat = (fail: boolean) =>
  asyncRoute(async (req: Request, res: Response) => {
    const message = typeof req.body === 'string' ? req.body : typeof req.query.msg === 'string' ? req.query.msg : undefined;
    const known = await recordHeartbeat(req.params.token, { fail, message });
    if (!known) return res.status(404).json({ error: 'Unknown heartbeat' });
    res.json({ ok: true });
  });

opsPublicRouter.all('/api/heartbeat/:token', anyText, heartbeat(false));
opsPublicRouter.all('/api/heartbeat/:token/fail', anyText, heartbeat(true));

/* ------------------------------ Twilio voice ------------------------------ */

/** Twilio signs the URL it called, so the public URL is rebuilt, not trusted from Host. */
async function verifyTwilio(req: Request): Promise<boolean> {
  const telephony = await loadTelephony();
  const base = await publicBaseUrl();
  const signature = req.header('x-twilio-signature');
  if (!telephony.authToken || !base || !signature) return false;
  const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  return timingSafeCompare(twilioSignature(telephony.authToken, `${base}${req.originalUrl}`, params), signature);
}

function twiml(res: Response, body: string) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

opsPublicRouter.post(
  '/api/webhooks/telephony/twilio/voice',
  asyncRoute(async (req, res) => {
    const attemptId = String(req.query.attempt ?? '');
    if (!verifyCallbackToken(attemptId, String(req.query.t ?? '')) || !(await verifyTwilio(req))) return res.status(403).end();
    const context = await attemptContext(attemptId);
    if (!context) return twiml(res, '<Response><Say>This page is no longer active. Goodbye.</Say></Response>');
    await markAttemptAnswered(attemptId);
    const digit = String(req.body?.Digits ?? '');
    if (digit === '1') {
      await acknowledgePage(context.pageId, context.user, 'voice');
      return twiml(res, '<Response><Say>Acknowledged. The escalation has stopped. Goodbye.</Say></Response>');
    }
    if (digit === '2') {
      await escalateNow(context.pageId, context.user.name);
      return twiml(res, '<Response><Say>Escalated to the next level. Goodbye.</Say></Response>');
    }
    const details = context.ticket ? `${context.ticket.reference}. ${context.ticket.subject}. ${context.ticket.description.slice(0, 400)}` : 'No details.';
    twiml(res, voiceTwiml(details, `${await publicBaseUrl()}${req.originalUrl.split('?')[0]}?attempt=${attemptId}&t=${req.query.t}`));
  }),
);

/** "ACK" by SMS acknowledges the latest page that reached the sender's number. */
opsPublicRouter.post(
  '/api/webhooks/telephony/twilio/sms',
  asyncRoute(async (req, res) => {
    if (!(await verifyTwilio(req))) return res.status(403).end();
    const from = normalisePhone(String(req.body?.From ?? ''));
    const body = String(req.body?.Body ?? '').trim().toUpperCase();
    if (!from) return twiml(res, '<Response/>');
    const found = await pageForPhone(from);
    if (!found) return twiml(res, '<Response><Message>No active page found for this number.</Message></Response>');
    if (/^(ACK|1|OK|YES)\b/.test(body)) {
      const outcome = await acknowledgePage(found.pageId, found.user, 'sms');
      return twiml(res, `<Response><Message>${escapeXml(outcome === 'closed' ? 'That page is already closed.' : 'Acknowledged. Escalation stopped.')}</Message></Response>`);
    }
    if (/^(ESC|2)\b/.test(body)) {
      await escalateNow(found.pageId, found.user.name);
      return twiml(res, '<Response><Message>Escalated to the next level.</Message></Response>');
    }
    twiml(res, '<Response><Message>Reply ACK to acknowledge or ESC to escalate.</Message></Response>');
  }),
);

/* ------------------------------ Status pages ------------------------------ */

/** Public pages are open to anyone; internal ones need a signed-in session. */
async function resolveVisiblePage(req: Request) {
  const page = await getStatusPage(req.params.slug);
  if (!page) return null;
  if (page.isPublic) return page;
  return (req as Partial<AuthedRequest>).user ? page : null;
}

opsPublicRouter.get(
  '/status/:slug',
  attachUser,
  asyncRoute(async (req, res) => {
    const page = await resolveVisiblePage(req);
    if (!page) return res.status(404).type('text/plain').send('Status page not found.');
    const settings = await getSettings();
    res.setHeader('Cache-Control', page.isPublic ? 'public, max-age=30' : 'private, no-store');
    res.type('html').send(statusPageHtml(await renderStatusPage(page), settings.organizationName));
  }),
);

opsPublicRouter.get(
  '/api/public/status/:slug',
  attachUser,
  asyncRoute(async (req, res) => {
    const page = await resolveVisiblePage(req);
    if (!page) return res.status(404).json({ error: 'Status page not found' });
    const view = await renderStatusPage(page);
    // Monitor ids are internal; the public JSON carries labels and states only.
    res.json({
      title: page.title,
      description: page.description,
      overall: view.overall,
      components: view.components.map(({ label, status, uptime90d }) => ({ label, status, uptime90d })),
      updates: view.updates.map(({ title, state, body, createdAt }) => ({ title, state, body, createdAt })),
      generatedAt: view.generatedAt,
    });
  }),
);
