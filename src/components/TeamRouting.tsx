import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import type { TeamRoute } from '@shared/types';

/**
 * Where this department's tickets are announced.
 *
 * Every field is optional. Left blank, the team uses whatever the integration
 * is configured with - so a company that wants one channel for everything
 * never has to come here.
 */
interface Draft {
  slackChannel: string;
  slackMention: string;
  linearTeamId: string;
  teamsWebhook: string;
}

const BLANK: Draft = { slackChannel: '', slackMention: '', linearTeamId: '', teamsWebhook: '' };

function toDraft(routes: TeamRoute[]): Draft {
  const find = (provider: string) => routes.find((route) => route.provider === provider);
  return {
    slackChannel: find('slack')?.target ?? '',
    slackMention: find('slack')?.mention ?? '',
    linearTeamId: find('linear')?.target ?? '',
    teamsWebhook: find('msteams')?.target ?? '',
  };
}

export function TeamRouting({ teamId, teamName }: { teamId: string; teamName: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDraft(null);
    void api.teams
      .routing(teamId)
      .then((result) => {
        if (!cancelled) setDraft(toDraft(result.routes));
      })
      .catch(() => {
        if (!cancelled) setDraft({ ...BLANK });
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const set = (key: keyof Draft, value: string) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.teams.saveRouting(teamId, [
        { provider: 'slack', target: draft.slackChannel, mention: draft.slackMention },
        { provider: 'linear', target: draft.linearTeamId },
        { provider: 'msteams', target: draft.teamsWebhook },
      ]);
      setDraft(toDraft(result.routes));
      toast.success(`Saved where ${teamName} tickets are announced.`);
    } catch (error) {
      toast.error('Could not save', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  if (!draft) return <p className="p-3 text-xs text-subtle">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">
        Leave anything blank to use the default set up in Integrations. Fill it in and {teamName} tickets go
        here instead.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Slack channel" hint="Channel ID, e.g. C01234ABCDE.">
          <Input
            value={draft.slackChannel}
            onChange={(event) => set('slackChannel', event.target.value)}
            placeholder="Use the default channel"
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="Ping on each ticket"
          hint="A user group like @hr-team, or @here. Paste the group's ID (S…) to be certain it notifies."
        >
          <Input
            value={draft.slackMention}
            onChange={(event) => set('slackMention', event.target.value)}
            placeholder="Nobody"
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Linear team ID" hint="Mirror this department's escalations into its own Linear team.">
          <Input
            value={draft.linearTeamId}
            onChange={(event) => set('linearTeamId', event.target.value)}
            placeholder="Use the default team"
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Teams webhook URL" hint="A Workflows URL for this department's channel.">
          <Input
            value={draft.teamsWebhook}
            onChange={(event) => set('teamsWebhook', event.target.value)}
            placeholder="Use the default webhook"
            className="font-mono text-xs"
          />
        </Field>
      </div>

      <Button size="sm" variant="primary" loading={saving} onClick={save}>
        Save routing
      </Button>
    </div>
  );
}
