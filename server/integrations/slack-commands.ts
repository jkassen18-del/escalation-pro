import type { Team } from '../../shared/types.ts';

/**
 * The slash command.
 *
 * One command is registered with Slack - `/gml` - and the department is an
 * argument, because Slack commands are configured one at a time in the app
 * manifest and cannot be wildcarded. Registering `/gml-finance`,
 * `/gml-hr` and so on would mean editing the Slack app and reinstalling it
 * every time somebody adds a department here, which is exactly the kind of
 * thing nobody remembers to do.
 *
 * So `/gml finance` goes straight to the finance form, `/gml` asks which
 * department first, and a department added in the admin UI works
 * immediately with no Slack-side change at all.
 */

/** Slack posts a command form-encoded; these are the fields that matter. */
export interface SlashCommand {
  command?: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  trigger_id?: string;
  team_domain?: string;
}

export function parseSlashCommand(body: unknown): SlashCommand | null {
  const form = body as Record<string, unknown> | undefined;
  if (!form || typeof form.trigger_id !== 'string' || typeof form.user_id !== 'string') return null;
  return {
    command: typeof form.command === 'string' ? form.command : undefined,
    text: typeof form.text === 'string' ? form.text : '',
    user_id: form.user_id,
    channel_id: typeof form.channel_id === 'string' ? form.channel_id : undefined,
    trigger_id: form.trigger_id,
  };
}

/**
 * Works out which department somebody meant.
 *
 * Generous on purpose: the text is typed in a hurry into a chat box, so the
 * team key, the team name, and the `gml-` prefix people will inevitably use
 * out of habit all resolve to the same team. An unrecognised word is not an
 * error - the modal simply opens with the picker unset.
 */
export function matchTeam(text: string | undefined, teams: Team[]): Team | null {
  const wanted = (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\/?gml[-\s]*/, '')
    .replace(/[^a-z0-9]+/g, '');
  if (!wanted) return null;

  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

  return (
    teams.find((team) => normalise(team.key) === wanted) ??
    teams.find((team) => normalise(team.name) === wanted) ??
    // Last resort: a prefix, so "fin" finds Finance.
    teams.find((team) => normalise(team.name).startsWith(wanted) || normalise(team.key).startsWith(wanted)) ??
    null
  );
}

/** A Slack Web API call with the bot token, returning the parsed body. */
export async function slackApi<T = Record<string, unknown>>(
  botToken: string,
  method: string,
  payload: unknown,
): Promise<T & { ok: boolean; error?: string }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as T & { ok: boolean; error?: string };
}

/**
 * What to say when somebody who cannot raise a ticket runs the command.
 *
 * Ephemeral, so the refusal is not broadcast to the channel, and specific,
 * so they know whether to ask for an account or for a permission.
 */
export function refusalText(reason: 'unknown' | 'inactive' | 'forbidden'): string {
  switch (reason) {
    case 'unknown':
      return (
        'Your Slack account is not linked to a user here, so no ticket was raised. ' +
        'Ask an administrator to add you with the same email address as your Slack profile.'
      );
    case 'inactive':
      return 'That account is no longer active here, so no ticket was raised.';
    case 'forbidden':
      return 'You do not have permission to raise tickets.';
  }
}
