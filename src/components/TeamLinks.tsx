import { useEffect, useState } from 'react';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { teamLinksApi } from '@/lib/sso-api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { TEAM_LINK_ICON_LABELS, TeamLinkIcon } from '@/components/TeamLinkIcon';
import { TEAM_LINK_ICONS, TEAM_LINK_PRESETS, type TeamLink, type TeamLinkIcon as Kind } from '@shared/sso';

interface Draft {
  id: string | null;
  name: string;
  url: string;
  icon: Kind;
  description: string;
}

const BLANK: Draft = { id: null, name: '', url: 'https://', icon: 'generic', description: '' };

/**
 * A team's links to the other systems it works in. Shown in the team dialog;
 * the team's members see them under Quick links.
 */
export function TeamLinks({ teamId }: { teamId: string }) {
  const toast = useToast();
  const [links, setLinks] = useState<TeamLink[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLinks(null);
    void teamLinksApi
      .list(teamId)
      .then((result) => !cancelled && setLinks(result.links))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const input = { teamId, name: draft.name, url: draft.url, icon: draft.icon, description: draft.description || null };
    try {
      if (draft.id) {
        const { link } = await teamLinksApi.update(draft.id, input);
        setLinks((current) => (current ?? []).map((item) => (item.id === link.id ? link : item)));
      } else {
        const { link } = await teamLinksApi.create(input);
        setLinks((current) => [...(current ?? []), link]);
      }
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the link.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (link: TeamLink) => {
    try {
      await teamLinksApi.remove(link.id);
      setLinks((current) => (current ?? []).filter((item) => item.id !== link.id));
    } catch (caught) {
      toast.error('Could not remove the link', caught instanceof ApiError ? caught.message : undefined);
    }
  };

  return (
    <div className="space-y-2.5 rounded-sm border p-3 surface-2">
      {links === null ? (
        <p className="text-xs text-subtle">Loading links…</p>
      ) : links.length === 0 && !draft ? (
        <p className="text-xs text-subtle">
          No links yet. Add the consoles this team works in; members see them under Quick links.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-2.5 rounded-sm border px-2.5 py-2 surface">
              <TeamLinkIcon kind={link.icon} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{link.name}</p>
                <p className="truncate font-mono text-2xs text-subtle">{link.url}</p>
              </div>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)]" aria-label={`Open ${link.name}`}>
                <ExternalLink className="size-3.5" />
              </a>
              <button
                type="button"
                onClick={() => setDraft({ id: link.id, name: link.name, url: link.url, icon: link.icon, description: link.description ?? '' })}
                className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                aria-label={`Edit ${link.name}`}
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void remove(link)}
                className="rounded-xs p-1 text-[var(--fg-subtle)] hover:text-[var(--priority-urgent)]"
                aria-label={`Remove ${link.name}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="space-y-3 rounded-sm border p-3 surface">
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <Field label="Name" htmlFor="link-name">
              <Input id="link-name" value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="AWS access portal" />
            </Field>
            <Field label="Kind" htmlFor="link-icon">
              <Select id="link-icon" value={draft.icon} onChange={(event) => set('icon', event.target.value as Kind)}>
                {TEAM_LINK_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {TEAM_LINK_ICON_LABELS[icon]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Address" htmlFor="link-url" hint={/[<>]/.test(draft.url) ? 'Replace the part in <angle brackets> with your own value.' : 'Must start with https://'}>
            <Input id="link-url" value={draft.url} onChange={(event) => set('url', event.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Description" htmlFor="link-description">
            <Input id="link-description" value={draft.description} onChange={(event) => set('description', event.target.value)} placeholder="Optional" />
          </Field>
          {error && <p className="text-xs text-[var(--priority-urgent)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={() => void save()} loading={saving}>
              {draft.id ? 'Save link' : 'Add link'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" onClick={() => setDraft({ ...BLANK })}>
            <Plus className="size-3.5" />
            Add link
          </Button>
          {TEAM_LINK_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null);
                setDraft({ id: null, name: preset.name, url: preset.url, icon: preset.icon, description: preset.description });
              }}
            >
              <TeamLinkIcon kind={preset.icon} className="size-5 border-0 bg-transparent" />
              {preset.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
