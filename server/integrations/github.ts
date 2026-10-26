import crypto from 'node:crypto';
import type { Request } from 'express';
import { findTeamRoute } from '../repositories/team-routing.ts';
import { db } from '../db/index.ts';
import { templateFor, valuesFor } from './message-format.ts';
import { linearIssueText } from './linear.ts';
import type { IntegrationRecord } from './store.ts';
import type { NotificationContext, TestResult } from './types.ts';

/**
 * GitHub: a ticket can become an issue in its department's repository, and
 * the issue reports back - closed resolves the ticket, a comment becomes a
 * comment, and a pull request that mentions the ticket's reference is linked
 * to it. Failed Actions runs and security alerts arrive separately, through a
 * GitHub alert source, so they page like any other monitoring signal.
 */

export interface GitHubConfig {
  /** A fine-grained personal access token: Issues read/write and Metadata read on the repositories. */
  token?: string;
  /** The secret set on the repository or organisation webhook, used to verify deliveries. */
  webhookSecret?: string;
  /** "owner/repo" for departments without a repository of their own. */
  repo?: string;
  /** An issue opened (or labelled) with this label raises a ticket. Empty turns that off. */
  ticketLabel?: string;
  /** Closing the issue resolves the ticket, and reopening reopens it. On unless set to false. */
  syncStatus?: boolean;
  /** Who the token belongs to, remembered by the connection test. */
  login?: string;
}

const API = 'https://api.github.com';
/** Marks comments this app posts, so the copy GitHub sends back is not recorded twice. */
export const OWN_COMMENT_MARKER = '<!-- infraticket -->';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoName(value: string): boolean {
  return REPO.test(value);
}

export async function github<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'InfraTicket',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { message?: string }) : ({} as T & { message?: string });
  if (!response.ok) {
    const reason = data.message ?? `HTTP ${response.status}`;
    const hint =
      response.status === 401
        ? ' The token is wrong or has expired.'
        : response.status === 403 || response.status === 404
          ? ' The token cannot see that repository, or lacks Issues read/write permission.'
          : '';
    throw new Error(`GitHub said: ${reason}.${hint}`);
  }
  return data;
}

/** The repositories the token can reach, for the department picker. */
export async function listGitHubRepos(token: string): Promise<Array<{ id: string; name: string }>> {
  const repos = await github<Array<{ full_name: string; private: boolean; archived: boolean; has_issues: boolean }>>(
    token,
    'GET',
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
  );
  return repos
    .filter((repo) => !repo.archived && repo.has_issues)
    .map((repo) => ({ id: repo.full_name, name: `${repo.private ? '🔒 ' : ''}${repo.full_name}` }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function testGitHub(record: IntegrationRecord): Promise<TestResult> {
  const config = record.config as GitHubConfig;
  if (!config.token) return { ok: false, message: 'Add a GitHub token first.' };
  try {
    const user = await github<{ login: string }>(config.token, 'GET', '/user');
    const routed = await db.all<{ target: string; name: string }>(
      `SELECT r.target, t.name FROM team_routing r JOIN teams t ON t.id = r.team_id WHERE r.provider = 'github' AND r.target <> ''`,
    );
    const wanted = [...routed, ...(config.repo ? [{ target: config.repo, name: 'Everything else' }] : [])];
    const unreachable: string[] = [];
    for (const entry of wanted) {
      try {
        await github(config.token, 'GET', `/repos/${entry.target}`);
      } catch {
        unreachable.push(`${entry.target} (${entry.name})`);
      }
    }
    if (unreachable.length) {
      return { ok: false, message: `Signed in as ${user.login}, but the token cannot reach ${unreachable.join(', ')}.`, details: { login: user.login } };
    }
    return {
      ok: true,
      message: wanted.length
        ? `Signed in as ${user.login}. Issues go to ${Array.from(new Set(wanted.map((entry) => entry.target))).join(', ')} by department.`
        : `Signed in as ${user.login}. Pick a repository for each department below.`,
      details: { login: user.login },
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** The repository a department's issues go to: its own, else the "everything else" one. */
export async function githubRepoFor(record: IntegrationRecord, departmentId: string | null): Promise<string | null> {
  const route = await findTeamRoute(departmentId, 'github');
  return route?.target || (record.config as GitHubConfig).repo || null;
}

/** The department a repository belongs to, for issues and pull requests coming the other way. */
export async function departmentForRepo(repo: string): Promise<string | null> {
  const row = await db.get<{ team_id: string }>(`SELECT team_id FROM team_routing WHERE provider = 'github' AND LOWER(target) = LOWER(?)`, [repo]);
  return row?.team_id ?? null;
}

export async function createGitHubIssue(
  record: IntegrationRecord,
  ctx: NotificationContext,
  options: { repo?: string | null } = {},
): Promise<{ ok: true; repo: string; number: number; url: string } | { ok: false; error: string }> {
  const config = record.config as GitHubConfig;
  if (!config.token) return { ok: false, error: 'GitHub is not connected under Integrations.' };
  const repo = options.repo || (await githubRepoFor(record, ctx.ticket.teamId));
  if (!repo) return { ok: false, error: `No GitHub repository is set for ${ctx.ticket.teamName ?? 'tickets without a department'}. Pick one under Integrations → GitHub.` };
  if (!isRepoName(repo)) return { ok: false, error: `"${repo}" is not an owner/repository name.` };

  // Same layout engine as Linear: GitHub issues are Markdown too.
  const { title, description } = linearIssueText(await templateFor('github'), await valuesFor(ctx));
  try {
    const issue = await github<{ number: number; html_url: string }>(config.token, 'POST', `/repos/${repo}/issues`, {
      title,
      body: `${description}\n\n${OWN_COMMENT_MARKER}`,
    });
    return { ok: true, repo, number: issue.number, url: issue.html_url };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function commentOnGitHubIssue(record: IntegrationRecord, issueKey: string, body: string): Promise<void> {
  const config = record.config as GitHubConfig;
  const match = /^(.+)#(\d+)$/.exec(issueKey);
  if (!config.token || !match) return;
  await github(config.token, 'POST', `/repos/${match[1]}/issues/${match[2]}/comments`, { body: `${body}\n\n${OWN_COMMENT_MARKER}` }).catch((error) =>
    console.warn(`[github] could not comment on ${issueKey}: ${(error as Error).message}`),
  );
}

/** GitHub signs each delivery: X-Hub-Signature-256 is an HMAC-SHA256 of the raw body. */
export function verifyGitHubSignature(req: Request, secret: string): boolean {
  const signature = req.header('x-hub-signature-256') ?? '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret || !raw || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ticket references (ESC-1042) mentioned in a pull request's title, body or branch. */
export function ticketReferences(prefix: string, ...texts: Array<string | null | undefined>): number[] {
  const pattern = new RegExp(`\\b${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{1,9})\\b`, 'gi');
  const numbers = new Set<number>();
  for (const text of texts) for (const match of String(text ?? '').matchAll(pattern)) numbers.add(Number(match[1]));
  return [...numbers].slice(0, 10);
}
