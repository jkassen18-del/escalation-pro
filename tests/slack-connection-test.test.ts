/**
 * What "Connection verified" is allowed to mean for Slack in bot mode.
 *
 * It used to mean only that auth.test accepted the token - which proves the
 * app exists, not that it can write anywhere. The bot was not a member of the
 * configured channel, so the test reported success while every real
 * notification would have been refused with not_in_channel. A test that passes
 * when the thing under test does not work is worse than no test.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { testSlack } from '../server/integrations/slack.ts';
import type { IntegrationRecord } from '../server/integrations/store.ts';

const record = (config: Record<string, unknown>): IntegrationRecord =>
  ({
    provider: 'slack',
    enabled: true,
    config,
    events: {} as IntegrationRecord['events'],
    status: 'untested',
  }) as IntegrationRecord;

const BOT = { mode: 'bot', botToken: 'x'.repeat(20), channel: 'C0123456789' };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers auth.test and chat.postMessage separately. */
function stubSlack(auth: unknown, post: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    const body = href.includes('auth.test') ? auth : post;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('a valid token alone is not reported as a working connection', async () => {
  const calls = stubSlack({ ok: true, team: 'GML', user: 'escalation' }, { ok: false, error: 'not_in_channel' });
  const result = await testSlack(record(BOT));

  assert.equal(result.ok, false, 'the bot cannot post, so the test must fail');
  assert.match(result.message, /not_in_channel/);
  assert.match(result.message, /Invite the app|chat:write\.public/i, 'says how to fix it');
  assert.ok(
    calls.some((call) => call.includes('chat.postMessage')),
    'it must actually try to post, not stop at auth.test',
  );
});

test('success means a message really was posted', async () => {
  stubSlack({ ok: true, team: 'GML', user: 'escalation' }, { ok: true, channel: 'C0123456789' });
  const result = await testSlack(record(BOT));

  assert.equal(result.ok, true);
  assert.match(result.message, /test message was posted/i);
  assert.match(result.message, /GML/, 'names the workspace it reached');
});

test('Slack error codes are explained rather than passed through raw', async () => {
  for (const [error, expected] of [
    ['channel_not_found', /channel ID/i],
    ['missing_scope', /chat:write/i],
  ] as const) {
    stubSlack({ ok: true, team: 'GML', user: 'escalation' }, { ok: false, error });
    const result = await testSlack(record(BOT));
    assert.equal(result.ok, false);
    assert.match(result.message, expected, `no guidance offered for ${error}`);
  }
});

test('a rejected token fails before anything is posted', async () => {
  const calls = stubSlack({ ok: false, error: 'invalid_auth' }, { ok: true });
  const result = await testSlack(record(BOT));

  assert.equal(result.ok, false);
  assert.match(result.message, /invalid_auth/);
  assert.ok(!calls.some((call) => call.includes('chat.postMessage')), 'no point posting with a dead token');
});

test('bot mode still refuses to test without a channel', async () => {
  stubSlack({ ok: true, team: 'GML', user: 'escalation' }, { ok: true });
  const result = await testSlack(record({ mode: 'bot', botToken: 'x'.repeat(20) }));
  assert.equal(result.ok, false);
  assert.match(result.message, /no channel/i);
});
