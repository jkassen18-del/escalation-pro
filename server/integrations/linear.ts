import type { DeliveryResult, NotificationContext, TestResult } from './types.ts';
import type { IntegrationRecord } from './store.ts';
import type { TicketPriority, TicketStatus } from '../../shared/types.ts';

const LINEAR_API = 'https://api.linear.app/graphql';

export interface LinearConfig {
  apiKey?: string;
  /** Linear team the issues are created in. */
  teamId?: string;
  teamKey?: string;
  /** Only mirror tickets at or above this priority. */
  minPriority?: TicketPriority;
  /** Create the Linear issue automatically, or only on manual push. */
  autoCreate?: boolean;
  /** Shared secret used to verify inbound Linear webhooks. */
  webhookSecret?: string;
}

/** Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
const PRIORITY_MAP: Record<TicketPriority, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        // Personal API keys are sent verbatim; OAuth tokens need the Bearer prefix.
        Authorization: apiKey.startsWith('lin_api_') ? apiKey : `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const body = (await response.json()) as GraphQlResponse<T>;
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
    if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}`);
    if (!body.data) throw new Error('Linear returned an empty response');
    return body.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Linear request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testLinear(record: IntegrationRecord): Promise<TestResult> {
  const config = record.config as LinearConfig;
  if (!config.apiKey) return { ok: false, message: 'A Linear API key is required.' };

  try {
    const data = await graphql<{
      viewer: { id: string; name: string; email: string };
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    }>(config.apiKey, `query { viewer { id name email } teams(first: 50) { nodes { id key name } } }`);

    const teams = data.teams.nodes;
    const selected = teams.find((team) => team.id === config.teamId);

    if (!config.teamId) {
      return {
        ok: false,
        message: `Key is valid for ${data.viewer.name}, but no Linear team is selected yet.`,
        details: { teams },
      };
    }
    if (!selected) {
      return { ok: false, message: 'The selected Linear team is no longer visible to this API key.', details: { teams } };
    }

    return {
      ok: true,
      message: `Connected to Linear as ${data.viewer.name}. Issues will be created in ${selected.key} · ${selected.name}.`,
      details: { teams, viewer: data.viewer },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Powers the team picker in the integrations UI. */
export async function listLinearTeams(apiKey: string) {
  const data = await graphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
    apiKey,
    `query { teams(first: 100) { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

export interface LinearIssueResult {
  ok: boolean;
  issueId?: string;
  identifier?: string;
  url?: string;
  error?: string;
}

export async function createLinearIssue(
  record: IntegrationRecord,
  ctx: NotificationContext,
): Promise<LinearIssueResult> {
  const config = record.config as LinearConfig;
  if (!config.apiKey) return { ok: false, error: 'Linear API key is not configured' };
  if (!config.teamId) return { ok: false, error: 'No Linear team selected' };

  const description = [
    ctx.ticket.description,
    '',
    '---',
    `Escalated from **${ctx.ticket.reference}** in Escalation Pro.`,
    `- Team: ${ctx.ticket.teamName ?? 'Unassigned'}`,
    `- Priority: ${ctx.ticket.priority}`,
    `- Requester: ${ctx.ticket.requesterName ?? 'Unknown'}`,
    `- [Open in Escalation Pro](${ctx.ticketUrl})`,
  ].join('\n');

  try {
    const data = await graphql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
    }>(
      config.apiKey,
      `mutation CreateIssue($input: IssueCreateInput!) {
         issueCreate(input: $input) {
           success
           issue { id identifier url }
         }
       }`,
      {
        input: {
          teamId: config.teamId,
          title: `[${ctx.ticket.reference}] ${ctx.ticket.subject}`,
          description,
          priority: PRIORITY_MAP[ctx.ticket.priority],
        },
      },
    );

    if (!data.issueCreate.success || !data.issueCreate.issue) {
      return { ok: false, error: 'Linear declined to create the issue' };
    }
    const issue = data.issueCreate.issue;
    return { ok: true, issueId: issue.id, identifier: issue.identifier, url: issue.url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Posts a comment onto an already-linked Linear issue. */
export async function commentOnLinearIssue(
  record: IntegrationRecord,
  issueId: string,
  body: string,
): Promise<DeliveryResult> {
  const config = record.config as LinearConfig;
  if (!config.apiKey) return { ok: false, statusCode: null, error: 'Linear API key is not configured' };

  try {
    await graphql<{ commentCreate: { success: boolean } }>(
      config.apiKey,
      `mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
    return { ok: true, statusCode: 200, error: null };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function shouldMirror(config: LinearConfig, priority: TicketPriority): boolean {
  if (!config.autoCreate) return false;
  const threshold = config.minPriority ?? 'high';
  return PRIORITY_RANK[priority] <= PRIORITY_RANK[threshold];
}

/** Maps a Linear workflow state back onto a local ticket status for inbound webhooks. */
export function mapLinearStateToStatus(stateType: string): TicketStatus | null {
  switch (stateType) {
    case 'triage':
    case 'backlog':
    case 'unstarted':
      return 'open';
    case 'started':
      return 'in_progress';
    case 'completed':
      return 'resolved';
    case 'canceled':
      return 'closed';
    default:
      return null;
  }
}
