import { Router, type Request } from 'express';
import { db } from '../db/index.ts';
import { clientIp, recordAudit } from '../lib/audit.ts';
import { asyncRoute, badRequest, requireEnum } from '../lib/http.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { listTeamRoutes, setTeamRoute } from '../repositories/team-routing.ts';
import { listConversations, findConversation } from '../repositories/teams-conversations.ts';
import { loadIntegration, saveIntegration } from '../integrations/store.ts';
import { listSlackChannels } from '../integrations/slack-install.ts';
import { listLinearTeams } from '../integrations/linear.ts';
import { senderName, postJson } from '../integrations/types.ts';
import { DEFAULT_TEMPLATES, TEMPLATE_PROVIDERS, normaliseTemplate, type TemplateProvider } from '../../shared/message-template.ts';
import type { IntegrationProvider } from '../../shared/types.ts';

/**
 * Where each department's tickets go in Slack, Teams and Linear, edited as one
 * table instead of a single channel plus IDs typed into each team's dialog -
 * and how those messages look. Mounted under /api/integrations, so it carries
 * that router's integrations.manage check.
 */
export const integrationRoutingRouter: Router = Router();

const ROUTED = ['slack', 'msteams', 'linear'] as const;
type Routed = (typeof ROUTED)[number];

export interface Destination {
  id: string;
  name: string;
  /** Why picking it may not work yet, e.g. the bot is not in that private channel. */
  warning?: string | null;
}

export interface RoutingView {
  provider: Routed;
  /** What a department's target is: a picked channel/team, or a pasted webhook URL. */
  kind: 'pick' | 'url';
  departments: Array<{ teamId: string; teamName: string; target: string; mention: string | null }>;
  /** Where a department without its own destination goes; '' or 'none' means not posted. */
  fallback: string;
  /** Teams bot only: '' means "the channel the bot was last active in". */
  fallbackOptions: Array<{ id: string; name: string }>;
  destinations: Destination[];
  /** Why the destination list is empty or routing is limited. */
  notice: string | null;
}

async function departments(provider: Routed) {
  const teams = await db.all<{ id: string; name: string }>(`SELECT id, name FROM teams ORDER BY name`);
  return Promise.all(
    teams.map(async (team) => {
      const route = (await listTeamRoutes(team.id)).find((entry) => entry.provider === provider);
      return { teamId: team.id, teamName: team.name, target: route?.target ?? '', mention: route?.mention ?? null };
    }),
  );
}

async function view(provider: Routed): Promise<RoutingView> {
  const record = await loadIntegration(provider);
  const config = record.config as Record<string, string | undefined>;
  const base = { provider, departments: await departments(provider), fallbackOptions: [] as RoutingView['fallbackOptions'] };

  if (provider === 'slack') {
    if (config.mode !== 'bot' || !config.botToken) {
      return {
        ...base,
        kind: 'pick',
        fallback: config.channel ?? '',
        destinations: [],
        notice: 'Per-department channels need the Slack app (Add to Slack above). An incoming webhook can only post to the one channel it was made for.',
      };
    }
    try {
      const channels = await listSlackChannels();
      return {
        ...base,
        kind: 'pick',
        fallback: config.channel ?? '',
        destinations: channels.map((channel) => ({
          id: channel.id,
          name: `${channel.isPrivate ? '🔒 ' : '#'}${channel.name}`,
          warning: channel.isPrivate && !channel.isMember ? 'Invite the app to this private channel first' : null,
        })),
        notice: null,
      };
    } catch (error) {
      return { ...base, kind: 'pick', fallback: config.channel ?? '', destinations: [], notice: (error as Error).message };
    }
  }

  if (provider === 'msteams') {
    if (config.mode !== 'bot') {
      return {
        ...base,
        kind: 'url',
        fallback: config.webhookUrl ?? '',
        destinations: [],
        notice: 'Paste a Workflows webhook URL for each department\'s channel. In Teams: the channel → ⋯ → Workflows → "Post to a channel when a webhook request is received".',
      };
    }
    const conversations = await listConversations();
    return {
      ...base,
      kind: 'pick',
      fallback: config.defaultConversationId ?? '',
      fallbackOptions: [{ id: '', name: 'The channel the bot was last active in' }],
      destinations: conversations.map((conversation) => ({
        id: conversation.conversationId,
        name: conversation.teamName ? `${conversation.teamName} / ${conversation.channelName ?? 'channel'}` : (conversation.channelName ?? 'Chat'),
      })),
      notice: conversations.length ? null : 'The bot has not been added to any channel yet. In Teams, open a channel → Apps → add the app, then reload.',
    };
  }

  if (!config.apiKey) return { ...base, kind: 'pick', fallback: config.teamId ?? '', destinations: [], notice: 'Add a Linear API key first.' };
  try {
    const teams = await listLinearTeams(config.apiKey);
    return { ...base, kind: 'pick', fallback: config.teamId ?? '', destinations: teams.map((team) => ({ id: team.id, name: `${team.name} (${team.key})` })), notice: null };
  } catch (error) {
    return { ...base, kind: 'pick', fallback: config.teamId ?? '', destinations: [], notice: `Could not list Linear teams: ${(error as Error).message}` };
  }
}

function validTarget(provider: Routed, kind: RoutingView['kind'], target: string): string {
  const value = target.trim();
  if (!value || value === 'none') return value;
  if (provider === 'slack' && !/^[CG][A-Z0-9]{6,}$/.test(value)) throw badRequest(`"${value}" is not a Slack channel. Pick one from the list.`);
  if (kind === 'url') {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw badRequest('A Teams webhook must be a full https:// address.');
    }
    if (url.protocol !== 'https:') throw badRequest('A Teams webhook must be a full https:// address.');
  }
  if (value.length > 1000) throw badRequest('That destination is too long.');
  return value;
}

async function audit(req: Request, action: string, summary: string) {
  const user = (req as AuthedRequest).user;
  await recordAudit({ actorId: user.id, actorName: user.name, entityType: 'integration', entityId: null, action, summary, ip: clientIp(req) });
}

integrationRoutingRouter.get(
  '/routing/:provider',
  asyncRoute(async (req, res) => {
    res.json(await view(requireEnum(req.params.provider, ROUTED, 'Provider')));
  }),
);

integrationRoutingRouter.put(
  '/routing/:provider',
  asyncRoute(async (req, res) => {
    const provider = requireEnum(req.params.provider, ROUTED, 'Provider');
    const current = await view(provider);
    const submitted = Array.isArray(req.body?.departments) ? (req.body.departments as Array<Record<string, unknown>>) : [];
    const known = new Map(current.departments.map((department) => [department.teamId, department]));

    for (const entry of submitted) {
      const teamId = String(entry.teamId ?? '');
      if (!known.has(teamId)) continue;
      let target = validTarget(provider, current.kind, String(entry.target ?? ''));
      if (target === 'none') target = '';
      if (provider === 'msteams' && current.kind === 'pick' && target && !(await findConversation(target))) {
        throw badRequest('That Teams channel is not one the bot has been added to.');
      }
      const mention = provider === 'slack' ? (typeof entry.mention === 'string' ? entry.mention : null) : null;
      await setTeamRoute(teamId, provider as IntegrationProvider, target, mention);
    }

    if (typeof req.body?.fallback === 'string') {
      const fallback = validTarget(provider, current.kind, req.body.fallback);
      const key = provider === 'slack' ? 'channel' : provider === 'linear' ? 'teamId' : current.kind === 'url' ? 'webhookUrl' : 'defaultConversationId';
      // Slack and Linear store "don't post" as empty; Teams bot needs 'none', since empty there means "last active channel".
      const stored = fallback === 'none' && key !== 'defaultConversationId' ? '' : fallback;
      if (key === 'webhookUrl' && !stored) throw badRequest('Webhook mode needs a default webhook URL; switch to the bot to leave some departments out.');
      await saveIntegration(provider, { config: { [key]: stored } });
    }

    await audit(req, 'routing_updated', `Updated where each department's tickets go in ${provider === 'msteams' ? 'Microsoft Teams' : provider === 'slack' ? 'Slack' : 'Linear'}`);
    res.json(await view(provider));
  }),
);

/**
 * Posts a short test into every distinct destination in the table, so a
 * channel the app cannot write to shows up now rather than on the first
 * real ticket.
 */
integrationRoutingRouter.post(
  '/routing/:provider/test',
  asyncRoute(async (req, res) => {
    const provider = requireEnum(req.params.provider, ['slack', 'msteams'] as const, 'Provider');
    const current = await view(provider);
    const record = await loadIntegration(provider);
    const config = record.config as Record<string, string | undefined>;
    const sender = await senderName();

    const targets = new Map<string, string[]>();
    for (const department of current.departments) {
      const target = department.target || (current.fallback === 'none' ? '' : current.fallback);
      if (!target) continue;
      targets.set(target, [...(targets.get(target) ?? []), department.teamName]);
    }
    if (current.fallback && current.fallback !== 'none' && !targets.has(current.fallback)) targets.set(current.fallback, ['Everything else']);

    const results: Array<{ target: string; name: string; departments: string[]; ok: boolean; error: string | null }> = [];
    for (const [target, names] of targets) {
      const name = current.destinations.find((destination) => destination.id === target)?.name ?? (current.kind === 'url' ? 'Webhook' : target);
      const text = `*${sender} is connected.* Tickets for ${names.join(', ')} will be posted here.`;
      let ok = false;
      let error: string | null = null;
      try {
        if (provider === 'slack') {
          const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: target, text }),
          });
          const body = (await response.json()) as { ok: boolean; error?: string };
          ok = body.ok;
          error = body.ok ? null : body.error === 'not_in_channel' ? 'The app is not in this channel. Invite it with /invite.' : (body.error ?? 'refused');
        } else if (current.kind === 'url') {
          const { status, text: reply } = await postJson(target, {
            type: 'message',
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive',
                contentUrl: null,
                content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: text.replace(/\*/g, '**'), wrap: true }] },
              },
            ],
          });
          ok = status === 200 || status === 202;
          error = ok ? null : `Teams returned ${status}: ${reply.slice(0, 120)}`;
        } else {
          const conversation = await findConversation(target);
          const { sendActivity } = await import('../integrations/teams-bot.ts');
          const sent = conversation
            ? await sendActivity(record.config as never, { serviceUrl: conversation.serviceUrl, conversationId: conversation.conversationId }, { text: text.replace(/\*/g, '**') })
            : { ok: false, error: 'The bot is no longer in this channel' };
          ok = sent.ok;
          error = sent.ok ? null : (sent.error ?? 'refused');
        }
      } catch (caught) {
        error = (caught as Error).message;
      }
      results.push({ target, name, departments: names, ok, error });
    }
    res.json({ results });
  }),
);

/* -------------------------------- Message designs -------------------------------- */

integrationRoutingRouter.get(
  '/templates/:provider',
  asyncRoute(async (req, res) => {
    const provider = requireEnum(req.params.provider, TEMPLATE_PROVIDERS, 'Provider') as TemplateProvider;
    const record = await loadIntegration(provider);
    res.json({ template: normaliseTemplate(provider, record.config.messageTemplate), defaults: DEFAULT_TEMPLATES[provider] });
  }),
);

integrationRoutingRouter.put(
  '/templates/:provider',
  asyncRoute(async (req, res) => {
    const provider = requireEnum(req.params.provider, TEMPLATE_PROVIDERS, 'Provider') as TemplateProvider;
    // `null` restores the default design.
    const template = req.body?.template === null ? null : normaliseTemplate(provider, req.body?.template);
    await saveIntegration(provider, { config: { messageTemplate: template } });
    await audit(req, 'message_template_updated', `${template ? 'Changed' : 'Reset'} how ${provider === 'msteams' ? 'Microsoft Teams' : provider === 'slack' ? 'Slack' : 'Linear'} messages look`);
    res.json({ template: normaliseTemplate(provider, template), defaults: DEFAULT_TEMPLATES[provider] });
  }),
);
