import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Download, Plus, Trash2, Upload } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { setupApi, type TeamsAppInput, type TeamsAppState, type TeamsCommand, type TeamsCommandAction } from '@/lib/integrations-setup-api';
import { templatesApi } from '@/lib/templates-api';
import { shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import type { Team } from '@shared/types';
import type { TicketTemplate } from '@shared/templates';

/**
 * The Teams app as an admin looks after it: download or update the package,
 * its name and icon, and the commands and forms it offers. Teams only takes
 * an update whose version is higher, so the server bumps it whenever the
 * package would change; this shows what changed and hands out the zip.
 */

type Draft = Omit<TeamsCommand, 'listed'>;

const BUILTIN_HINT: Record<string, string> = {
  help: 'Lists the commands',
  new: 'Department or quick-ticket picker, then its form',
  status: 'A ticket’s status, if they may see it',
  mine: 'Their open tickets',
  oncall: 'Who is on call now',
};

const readIcon = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const image = new Image();
      image.onload = () => (image.width === 192 && image.height === 192 ? resolve(url) : reject(new Error(`Teams needs a 192x192 PNG; this one is ${image.width}x${image.height}.`)));
      image.onerror = () => reject(new Error('That is not an image.'));
      image.src = url;
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

export function TeamsAppPanel({ appConfigured }: { appConfigured: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<TeamsAppState | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [templates, setTemplates] = useState<TicketTemplate[]>([]);
  const [details, setDetails] = useState({ name: '', shortDescription: '', fullDescription: '', accentColor: '', minimumVersion: '' });
  const [icon, setIcon] = useState<string | null | undefined>(undefined);
  const [commands, setCommands] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const apply = useCallback((next: TeamsAppState) => {
    setState(next);
    setDetails({
      name: next.settings.name,
      shortDescription: next.settings.shortDescription,
      fullDescription: next.settings.fullDescription,
      accentColor: next.settings.accentColor,
      minimumVersion: next.settings.minimumVersion,
    });
    setIcon(undefined);
    setCommands(next.commands.map(({ listed: _listed, ...rest }) => rest));
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await setupApi.teams.app());
    } catch {
      setState(null);
    }
  }, [apply]);

  useEffect(() => {
    void load();
    void api.teams.list().then((result) => setTeams(result.teams)).catch(() => undefined);
    void templatesApi.all().then((result) => setTemplates(result.templates)).catch(() => undefined);
  }, [load]);

  const dirty = useMemo(() => {
    if (!state) return false;
    const s = state.settings;
    const sameDetails =
      details.name === s.name &&
      details.shortDescription === s.shortDescription &&
      details.fullDescription === s.fullDescription &&
      details.accentColor === s.accentColor &&
      details.minimumVersion === s.minimumVersion;
    const sameCommands = JSON.stringify(commands) === JSON.stringify(state.commands.map(({ listed: _listed, ...rest }) => rest));
    return !sameDetails || !sameCommands || icon !== undefined;
  }, [state, details, commands, icon]);

  const listedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const command of commands) if (command.enabled && ids.size < (state?.limits.commands ?? 10)) ids.add(command.id);
    return ids;
  }, [commands, state]);

  const save = async () => {
    setSaving(true);
    try {
      const input: TeamsAppInput = {
        ...details,
        ...(icon !== undefined ? { icon } : {}),
        commands: commands.map((command) => ({
          id: command.id,
          kind: command.kind,
          ref: command.kind === 'builtin' ? command.builtin : command.kind === 'department' ? command.teamId : undefined,
          title: command.title,
          description: command.description,
          enabled: command.enabled,
          action: command.action,
        })),
      };
      apply(await setupApi.teams.saveApp(input));
      toast.success('Teams app saved', 'Download the package again and upload it to Teams to apply the changes.');
    } catch (caught) {
      toast.error('Could not save', caught instanceof ApiError ? caught.message : '');
    } finally {
      setSaving(false);
    }
  };

  const move = (index: number, by: number) =>
    setCommands((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
      return next;
    });

  const update = (id: string, patch: Partial<Draft>) => setCommands((list) => list.map((command) => (command.id === id ? { ...command, ...patch } : command)));

  const onIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      setIcon(await readIcon(file));
    } catch (caught) {
      toast.error('Icon not used', (caught as Error).message);
    }
  };

  if (!state) return <p className="text-xs text-subtle">Loading the Teams app…</p>;

  const firstInstall = !state.lastDownload;
  const accent = /^#[0-9a-f]{6}$/i.test(details.accentColor) ? details.accentColor : '#1F2937';

  return (
    <div className="space-y-5">
      {/* The package */}
      <section className="space-y-3 rounded-md border p-3.5 surface-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">
              Version {state.version}
              {state.updateAvailable && <span className="ml-2 rounded-xs bg-[var(--accent)]/15 px-1.5 py-0.5 text-2xs font-medium text-[var(--accent)]">Update ready</span>}
            </p>
            <p className="text-2xs text-subtle">
              {state.lastDownload ? `Last downloaded: version ${state.lastDownload.version}, ${shortDateTime(state.lastDownload.at)}` : 'Not downloaded yet'}
            </p>
          </div>
          <Button
            size="sm"
            variant={state.updateAvailable || firstInstall ? 'primary' : 'secondary'}
            disabled={!appConfigured || dirty}
            title={dirty ? 'Save your changes first' : !appConfigured ? 'Save the bot’s Microsoft app ID first' : undefined}
            onClick={() => {
              window.location.assign(setupApi.teams.packageUrl);
              // The download is recorded server-side; refresh the version shown.
              window.setTimeout(() => void load(), 1500);
            }}
          >
            <Download className="size-3.5" />
            {firstInstall ? 'Download the Teams app' : state.updateAvailable ? 'Download updated package' : 'Download again'}
          </Button>
        </div>

        {state.changes.length > 0 && (
          <div>
            <p className="text-2xs font-medium uppercase tracking-wide text-subtle">{firstInstall ? 'About this package' : 'Changed since the last download'}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              {state.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        )}

        {state.problems.length > 0 && (
          <div className="space-y-1 rounded-sm border border-[var(--priority-high)]/40 px-2.5 py-2 text-xs text-[var(--priority-high)]" role="status">
            <p className="flex items-center gap-1.5 font-medium">
              <CircleAlert className="size-3.5" />
              Check before uploading
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 text-xs text-[var(--fg-muted)] sm:grid-cols-2">
          <div>
            <p className="font-medium text-[var(--fg)]">First install</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>Download the package.</li>
              <li>Just you, to try it: Teams → Apps → Manage your apps → Upload an app → Upload a custom app.</li>
              <li>Everyone: Teams admin center → Teams apps → Manage apps → Upload new app, then allow it in a setup or permission policy.</li>
            </ol>
          </div>
          <div>
            <p className="font-medium text-[var(--fg)]">Updating it</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>Change the details or commands below and save; the version goes up by itself.</li>
              <li>Download the updated package.</li>
              <li>Teams admin center → Manage apps → {state.settings.name || state.settings.defaultName} → Upload file. A custom app you uploaded yourself: Manage your apps → … → Update.</li>
            </ol>
          </div>
        </div>
      </section>

      {/* Details */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold">App details</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint={`Shown in Teams. Up to ${state.limits.shortName} characters.`}>
            <Input value={details.name} placeholder={state.settings.defaultName} maxLength={state.limits.shortName} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
          </Field>
          <Field label="Accent colour" hint="Background of the generated icon and the app tile.">
            <div className="flex gap-2">
              <input
                type="color"
                aria-label="Pick accent colour"
                value={accent}
                onChange={(e) => setDetails({ ...details, accentColor: e.target.value.toUpperCase() })}
                className="h-8 w-10 shrink-0 cursor-pointer rounded-sm border"
              />
              <Input value={details.accentColor} placeholder="#1F2937" maxLength={7} onChange={(e) => setDetails({ ...details, accentColor: e.target.value })} />
            </div>
          </Field>
        </div>
        <Field label="Short description" hint={`Up to ${state.limits.shortDescription} characters.`}>
          <Input value={details.shortDescription} placeholder="Raise and answer tickets without leaving Teams." maxLength={state.limits.shortDescription} onChange={(e) => setDetails({ ...details, shortDescription: e.target.value })} />
        </Field>
        <Field label="Full description" hint="Shown on the app’s page in Teams. Leave blank for the standard text.">
          <Textarea rows={3} value={details.fullDescription} maxLength={state.limits.fullDescription} onChange={(e) => setDetails({ ...details, fullDescription: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Icon" hint="A 192x192 PNG. Without one, a tile in the accent colour is generated.">
            <div className="flex items-center gap-2">
              <span className="flex size-10 items-center justify-center overflow-hidden rounded-md border" style={{ background: accent }}>
                {typeof icon === 'string' ? <img src={icon} alt="New icon" className="size-full object-cover" /> : <span className="text-2xs text-white">{icon === null ? 'auto' : state.settings.hasCustomIcon ? 'custom' : 'auto'}</span>}
              </span>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--surface-3)]">
                <Upload className="size-3.5" />
                Upload PNG
                <input type="file" accept="image/png" className="sr-only" onChange={onIcon} />
              </label>
              {(state.settings.hasCustomIcon || typeof icon === 'string') && icon !== null && (
                <Button size="sm" variant="ghost" onClick={() => setIcon(null)}>
                  Use generated
                </Button>
              )}
            </div>
          </Field>
          <Field label="Minimum version" hint="Only if this app was already uploaded at a higher version from somewhere else.">
            <Input value={details.minimumVersion} placeholder="e.g. 2.0.0" onChange={(e) => setDetails({ ...details, minimumVersion: e.target.value })} />
          </Field>
        </div>
      </section>

      {/* Commands */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold">Commands</h3>
            <p className="text-2xs text-subtle">
              Teams shows the first {state.limits.commands} switched-on commands in its menu. Others still work when typed. In a channel, people mention the bot first.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add command
          </Button>
        </div>
        <ul className="divide-y rounded-md border">
          {commands.map((command, index) => (
            <li key={command.id} className={cn('flex flex-wrap items-center gap-2 px-2.5 py-2', !command.enabled && 'opacity-60')}>
              <Checkbox aria-label={`Turn ${command.title} on or off`} checked={command.enabled} onChange={(e) => update(command.id, { enabled: e.target.checked })} />
              <span className="w-24 shrink-0 truncate font-mono text-xs">{command.title}</span>
              <Input
                aria-label={`Description of ${command.title}`}
                className="min-w-40 flex-1"
                value={command.description}
                maxLength={state.limits.commandDescription}
                onChange={(e) => update(command.id, { description: e.target.value })}
              />
              <span className="w-28 shrink-0 text-2xs text-subtle">
                {command.kind === 'builtin'
                  ? BUILTIN_HINT[command.builtin ?? ''] ?? 'Built in'
                  : command.kind === 'department'
                    ? 'Department form'
                    : describeAction(command.action, teams, templates)}
                {command.enabled && !listedIds.has(command.id) && <span className="block text-[var(--priority-high)]">Not in the menu</span>}
              </span>
              <span className="flex shrink-0">
                <Button size="icon" variant="ghost" aria-label={`Move ${command.title} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Move ${command.title} down`} disabled={index === commands.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown className="size-3.5" />
                </Button>
                {command.kind === 'custom' && (
                  <Button size="icon" variant="ghost" aria-label={`Delete ${command.title}`} onClick={() => setCommands((list) => list.filter((entry) => entry.id !== command.id))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {adding && (
          <NewCommand
            teams={teams}
            templates={templates}
            taken={commands.map((command) => command.title)}
            onCancel={() => setAdding(false)}
            onAdd={(command) => {
              setCommands((list) => [...list, command]);
              setAdding(false);
            }}
          />
        )}
      </section>

      <section className="space-y-1 text-xs text-[var(--fg-muted)]">
        <h3 className="text-xs font-semibold text-[var(--fg)]">Forms</h3>
        <p>
          The package adds <b>Raise a ticket</b> to the compose box’s apps (…) and the command box, and <b>Create ticket from message</b> to every message’s … → More actions menu. Both
          open a pop-up form: pick a department or quick ticket, fill in its questions, and the confirmation card can be posted to the conversation. Forms only accept people whose Teams
          account matches a user here with permission to raise tickets.
        </p>
      </section>

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => apply(state)}>
          Discard
        </Button>
        <Button size="sm" loading={saving} disabled={!dirty} onClick={save}>
          Save Teams app
        </Button>
      </div>
    </div>
  );
}

function describeAction(action: TeamsCommandAction | undefined, teams: Team[], templates: TicketTemplate[]): string {
  if (!action) return 'Custom';
  if (action.type === 'department') return `Form: ${teams.find((team) => team.id === action.teamId)?.name ?? 'department'}`;
  if (action.type === 'template') return `Quick ticket: ${templates.find((template) => template.id === action.templateId)?.name ?? 'template'}`;
  return 'Replies with text';
}

function NewCommand({
  teams,
  templates,
  taken,
  onAdd,
  onCancel,
}: {
  teams: Team[];
  templates: TicketTemplate[];
  taken: string[];
  onAdd: (command: Draft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TeamsCommandAction['type']>('department');
  const [target, setTarget] = useState('');
  const [replyText, setReplyText] = useState('');
  const [url, setUrl] = useState('');

  const name = title.trim().toLowerCase();
  const error = !name
    ? null
    : !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)
      ? 'One word: letters, digits, - or _'
      : taken.includes(name)
        ? 'That command already exists'
        : null;
  const ready =
    Boolean(name) && !error && Boolean(description.trim()) && (type === 'reply' ? Boolean(replyText.trim() || url.trim()) : Boolean(target));

  const add = () => {
    const action: TeamsCommandAction =
      type === 'department' ? { type, teamId: target } : type === 'template' ? { type, templateId: target } : { type, text: replyText.trim(), url: url.trim() || null };
    onAdd({ id: `custom:new-${Date.now()}`, kind: 'custom', title: name, description: description.trim(), enabled: true, action });
  };

  return (
    <div className="space-y-3 rounded-md border p-3 surface-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Command" error={error ?? undefined} hint="What people type, e.g. laptop">
          <Input value={title} maxLength={32} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" hint="Shown in Teams’ command menu">
          <Input value={description} maxLength={128} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <Field label="What it does">
        <Select
          value={type}
          onChange={(e) => {
            setType(e.target.value as TeamsCommandAction['type']);
            setTarget('');
          }}
        >
          <option value="department">Open a department’s form</option>
          <option value="template">Open a quick ticket’s form</option>
          <option value="reply">Reply with text or a link</option>
        </Select>
      </Field>
      {type === 'department' && (
        <Field label="Department">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {type === 'template' && (
        <Field label="Quick ticket">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {type === 'reply' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reply">
            <Textarea rows={2} value={replyText} maxLength={2000} onChange={(e) => setReplyText(e.target.value)} />
          </Field>
          <Field label="Link (optional)">
            <Input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
