import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Globe, Lock, Megaphone, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi, type StatusPageInput } from '@/lib/ops-api';
import { fullDateTime, shortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorPane, LoadingPane } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { COMPONENT_STATUS_COLORS, COMPONENT_STATUS_LABELS, UptimeBars } from '@/components/ops/MonitorShared';
import { STATUS_UPDATE_STATES, type Monitor, type StatusPage, type StatusPageAppearance, type StatusPageView, type StatusUpdateState } from '@shared/ops';

function message(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const OVERALL_HEADLINES: Record<StatusPageView['overall'], string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'Outage in progress',
  maintenance: 'Maintenance in progress',
  unknown: 'No data yet',
};

const UPDATE_COLORS: Record<StatusUpdateState, string> = {
  investigating: 'var(--priority-urgent)',
  identified: 'var(--priority-high)',
  monitoring: '#2563eb',
  resolved: '#16a34a',
  maintenance: '#2563eb',
};

export function StatusPagesPage() {
  useDocumentTitle('Status pages');
  const { can } = useAuth();
  const canManage = can('statuspages.manage');
  const toast = useToast();
  const [pages, setPages] = useState<StatusPage[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StatusPage | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StatusPage | null>(null);
  const [viewVersion, setViewVersion] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, m] = await Promise.all([opsApi.statusPages.list(), opsApi.monitors.list()]);
      setPages(p.pages);
      setMonitors(m.monitors);
      setSelectedId((current) => (current && p.pages.some((page) => page.id === current) ? current : (p.pages[0]?.id ?? null)));
    } catch (caught) {
      setError(message(caught, 'Could not load status pages.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = pages.find((page) => page.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader docs="status-pages"
        title="Status pages"
        description="Public pages for customers and internal pages for staff, fed by your monitors. As many as you need."
        actions={
          canManage && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New status page
            </Button>
          )
        }
      />

      {error ? (
        <ErrorPane message={error} retry={load} />
      ) : loading ? (
        <LoadingPane label="Loading status pages" />
      ) : pages.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No status pages yet"
          description="Pick the monitors that matter to your customers and publish their state, with 90 days of uptime and your incident updates."
          action={
            canManage && (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Create a status page
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 p-4 sm:p-6 grid-cols-[minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className="space-y-2">
            {pages.map((page) => (
              <li key={page.id}>
                <div
                  className={cn(
                    'flex items-start justify-between gap-2 rounded-md border p-3 surface transition-colors',
                    page.id === selectedId ? 'border-[var(--fg)]' : 'hover:bg-[var(--surface-2)]',
                  )}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(page.id)}>
                    <p className="truncate text-sm font-medium">{page.title}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle">
                      {page.isPublic ? <Globe className="size-3" /> : <Lock className="size-3" />}
                      {page.isPublic ? 'Public' : 'Internal'} · /status/{page.slug}
                    </p>
                  </button>
                  {canManage && (
                    <Menu
                      trigger={({ toggle }) => (
                        <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Actions for ${page.title}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      )}
                      items={[
                        { label: 'Edit', onSelect: () => setEditing(page) },
                        { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setDeleting(page) },
                      ]}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>

          {selected && <StatusPagePreview key={`${selected.id}-${viewVersion}`} page={selected} canPost={can('statuspages.post')} />}
        </div>
      )}

      {(creating || editing) && (
        <StatusPageDialog
          page={editing}
          monitors={monitors}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async (saved) => {
            setCreating(false);
            setEditing(null);
            setSelectedId(saved.id);
            await load();
            setViewVersion((v) => v + 1);
            toast.success('Status page saved.');
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.title ?? ''}?`}
        message="Its address stops working and its posted updates are deleted. Monitors are not affected."
        confirmLabel="Delete page"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await opsApi.statusPages.remove(deleting.id);
            setDeleting(null);
            await load();
            toast.success('Status page deleted.');
          } catch (caught) {
            toast.error('Could not delete', message(caught, ''));
          }
        }}
      />
    </div>
  );
}

function StatusPagePreview({ page, canPost }: { page: StatusPage; canPost: boolean }) {
  const [view, setView] = useState<StatusPageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      setView((await opsApi.statusPages.view(page.id)).view);
    } catch (caught) {
      setError(message(caught, 'Could not load the page.'));
    }
  }, [page.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorPane message={error} retry={load} />;
  if (!view) return <LoadingPane />;

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {page.title}
            <Badge dot={false}>{page.isPublic ? 'Public' : 'Internal'}</Badge>
          </h2>
          {page.description && <p className="mt-0.5 text-xs text-muted">{page.description}</p>}
        </div>
        <div className="flex gap-2">
          <a href={`/status/${page.slug}`} target="_blank" rel="noreferrer">
            <Button size="sm">
              <ExternalLink className="size-3.5" />
              Open page
            </Button>
          </a>
          {canPost && (
            <Button size="sm" variant="primary" onClick={() => setPosting(true)}>
              <Megaphone className="size-3.5" />
              Post update
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md px-4 py-3 text-sm font-semibold text-white" style={{ background: COMPONENT_STATUS_COLORS[view.overall] }}>
        {OVERALL_HEADLINES[view.overall]}
      </div>

      {view.components.length === 0 ? (
        <p className="rounded-md border px-4 py-6 text-center text-xs text-subtle surface">No components yet. Edit the page to add monitors to it.</p>
      ) : (
        <ul className="divide-y rounded-md border surface">
          {view.components.map((component) => (
            <li key={component.monitorId} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{component.label}</span>
                <span className="shrink-0 text-xs font-medium" style={{ color: COMPONENT_STATUS_COLORS[component.status] }}>
                  {COMPONENT_STATUS_LABELS[component.status]}
                </span>
              </div>
              <UptimeBars days={component.days} className="mt-2" />
              <div className="mt-1 flex justify-between text-2xs text-subtle">
                <span>90 days ago</span>
                <span>{component.uptime90d === null ? '' : `${component.uptime90d}% uptime`}</span>
                <span>Today</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className="eyebrow mb-2">Updates in the last 14 days</p>
        {view.updates.length === 0 ? (
          <p className="text-xs text-subtle">Nothing posted.</p>
        ) : (
          <ul className="space-y-2">
            {view.updates.map((update) => (
              <li key={update.id} className="rounded-md border p-3 surface">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {update.title}
                  <Badge color={UPDATE_COLORS[update.state]}>{update.state}</Badge>
                </p>
                {update.body && <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{update.body}</p>}
                <time className="mt-1 block text-2xs text-subtle" title={fullDateTime(update.createdAt)}>
                  {shortDateTime(update.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>

      {posting && (
        <StatusUpdateDialog
          page={page}
          onClose={() => setPosting(false)}
          onPosted={(next) => {
            setPosting(false);
            setView(next);
          }}
        />
      )}
    </section>
  );
}

function StatusUpdateDialog({ page, onClose, onPosted }: { page: StatusPage; onClose: () => void; onPosted: (view: StatusPageView) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [state, setState] = useState<StatusUpdateState>('investigating');
  const [body, setBody] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    setSaving(true);
    setError(null);
    try {
      const { view } = await opsApi.statusPages.postUpdate(page.id, { title, state, body, ticketId: ticketId.trim() || null });
      toast.success('Update posted.');
      onPosted(view);
    } catch (caught) {
      setError(message(caught, 'Could not post the update.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Post to ${page.title}`}
      description={page.isPublic ? 'This page is public: anyone with the link will read this.' : 'Visible to signed-in staff only.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={post} loading={saving} disabled={!title.trim()}>
            Post update
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="text-xs text-[var(--priority-urgent)]">{error}</p>}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout errors for some customers" />
        </Field>
        <Field label="State">
          <Select value={state} onChange={(e) => setState(e.target.value as StatusUpdateState)}>
            {STATUS_UPDATE_STATES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What people should know" hint="Written for the reader of this page. Internal ticket notes are never published.">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Related incident (optional)" hint="The incident's ticket id, kept for your records; not shown on the page.">
          <Input value={ticketId} onChange={(e) => setTicketId(e.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
    </Modal>
  );
}

function StatusPageDialog({
  page,
  monitors,
  onClose,
  onSaved,
}: {
  page: StatusPage | null;
  monitors: Monitor[];
  onClose: () => void;
  onSaved: (page: StatusPage) => void;
}) {
  const [form, setForm] = useState<StatusPageInput>(
    page
      ? { title: page.title, slug: page.slug, description: page.description, isPublic: page.isPublic, components: page.components, appearance: page.appearance ?? {} }
      : { title: '', slug: '', description: null, isPublic: true, components: [], appearance: { theme: 'auto', showLogo: true } },
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(page));
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

  const move = (index: number, delta: number) =>
    setForm((current) => {
      const components = [...current.components];
      const [item] = components.splice(index, 1);
      components.splice(index + delta, 0, item);
      return { ...current, components };
    });

  const available = monitors.filter((m) => !form.components.some((c) => c.monitorId === m.id));

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = page ? await opsApi.statusPages.update(page.id, form) : await opsApi.statusPages.create(form);
      onSaved(result.page);
    } catch (caught) {
      setError(message(caught, 'Could not save the page.'));
      if (caught instanceof ApiError && caught.details) setFieldErrors(caught.details);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={page ? `Edit ${page.title}` : 'New status page'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!form.title.trim()}>
            {page ? 'Save changes' : 'Create page'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="rounded-sm border border-[var(--priority-urgent)]/30 bg-[var(--priority-urgent)]/5 px-3 py-2 text-xs text-[var(--priority-urgent)]">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" required error={fieldErrors.title}>
            <Input
              value={form.title}
              onChange={(e) => {
                const title = e.target.value;
                setForm((current) => ({ ...current, title, slug: slugTouched ? current.slug : slugify(title) }));
              }}
              placeholder="Acme status"
            />
          </Field>
          <Field label="Address" error={fieldErrors.slug} hint={`${window.location.origin}/status/${form.slug || '…'}`}>
            <Input
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm((current) => ({ ...current, slug: slugify(e.target.value) }));
              }}
              className="font-mono text-xs"
              placeholder="acme"
            />
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={2} value={form.description ?? ''} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value || null }))} />
        </Field>
        <Checkbox
          label="Public"
          hint="Public pages can be read by anyone with the link. Internal pages need a signed-in account."
          checked={form.isPublic}
          onChange={(e) => setForm((c) => ({ ...c, isPublic: e.target.checked }))}
        />

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium">Components</legend>
          <p className="text-2xs text-subtle">Each component shows one monitor's state, under the name your readers know it by.</p>
          {form.components.length > 0 && (
            <ul className="divide-y rounded-md border">
              {form.components.map((component, index) => {
                const monitor = monitors.find((m) => m.id === component.monitorId);
                return (
                  <li key={component.monitorId} className="flex items-center gap-2 px-2 py-1.5">
                    <div className="flex flex-col">
                      <button type="button" disabled={index === 0} onClick={() => move(index, -1)} className="text-[var(--fg-subtle)] hover:text-[var(--fg)] disabled:opacity-30" aria-label="Move up">
                        <ArrowUp className="size-3" />
                      </button>
                      <button
                        type="button"
                        disabled={index === form.components.length - 1}
                        onClick={() => move(index, 1)}
                        className="text-[var(--fg-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
                        aria-label="Move down"
                      >
                        <ArrowDown className="size-3" />
                      </button>
                    </div>
                    <Input
                      value={component.label}
                      onChange={(e) =>
                        setForm((c) => ({ ...c, components: c.components.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)) }))
                      }
                      className="h-7 flex-1"
                      aria-label="Label"
                    />
                    <span className="hidden max-w-[10rem] truncate text-2xs text-subtle sm:block">{monitor?.name ?? 'Deleted monitor'}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setForm((c) => ({ ...c, components: c.components.filter((_, i) => i !== index) }))}
                      aria-label="Remove component"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex gap-2">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="flex-1" disabled={available.length === 0}>
              <option value="">{available.length ? 'Add a monitor…' : monitors.length ? 'Every monitor is on this page' : 'Create monitors first'}</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button
              disabled={!adding}
              onClick={() => {
                const monitor = monitors.find((m) => m.id === adding);
                if (!monitor) return;
                setForm((c) => ({ ...c, components: [...c.components, { monitorId: monitor.id, label: monitor.name }] }));
                setAdding('');
              }}
            >
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>
        </fieldset>

        <AppearanceFields
          value={form.appearance}
          errors={fieldErrors}
          onChange={(appearance) => setForm((c) => ({ ...c, appearance }))}
        />
      </div>
    </Modal>
  );
}

/**
 * Look and feel. The defaults match the app; a brand colour, the logo and a
 * few words cover most needs, and custom CSS covers the rest.
 */
function AppearanceFields({
  value,
  errors,
  onChange,
}: {
  value: StatusPageAppearance;
  errors: Record<string, string>;
  onChange: (value: StatusPageAppearance) => void;
}) {
  const [showCss, setShowCss] = useState(Boolean(value.customCss));
  const set = <K extends keyof StatusPageAppearance>(key: K, next: StatusPageAppearance[K]) => onChange({ ...value, [key]: next });
  const accentValid = !value.accentColor || /^#[0-9a-f]{6}$/i.test(value.accentColor);

  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend className="mb-1.5 text-xs font-medium">Appearance</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Theme" hint="Automatic follows each visitor's light or dark setting.">
          <Select value={value.theme ?? 'auto'} onChange={(e) => set('theme', e.target.value as StatusPageAppearance['theme'])}>
            <option value="auto">Automatic</option>
            <option value="light">Always light</option>
            <option value="dark">Always dark</option>
          </Select>
        </Field>
        <Field label="Brand colour" hint="Links and highlights. Leave blank for the app's brass." error={errors.accentColor ?? (accentValid ? undefined : 'Use #rrggbb')}>
          <div className="flex gap-2">
            <input
              type="color"
              value={accentValid && value.accentColor ? value.accentColor : '#b4863a'}
              onChange={(e) => set('accentColor', e.target.value)}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-sm border bg-transparent"
              aria-label="Pick a colour"
            />
            <Input value={value.accentColor ?? ''} onChange={(e) => set('accentColor', e.target.value || undefined)} placeholder="#b4863a" className="font-mono text-xs" />
          </div>
        </Field>
        <Field label="Header name" hint="Defaults to the organisation name.">
          <Input value={value.headerText ?? ''} onChange={(e) => set('headerText', e.target.value || undefined)} />
        </Field>
        <Field label="Support link" hint="https://… or mailto:…" error={errors.supportUrl}>
          <Input value={value.supportUrl ?? ''} onChange={(e) => set('supportUrl', e.target.value || undefined)} placeholder="https://support.example.com" />
        </Field>
      </div>
      <Field label="Footer text">
        <Input value={value.footerText ?? ''} onChange={(e) => set('footerText', e.target.value || undefined)} placeholder="© Your company" />
      </Field>
      <Checkbox
        label="Show the organisation logo"
        hint="The logo uploaded under Settings. Without one, the page shows your initials."
        checked={value.showLogo !== false}
        onChange={(e) => set('showLogo', e.target.checked)}
      />
      {showCss ? (
        <Field label="Custom CSS" hint="Appended after the built-in styles, so it overrides them. Variables: --bg, --surface, --fg, --accent, --ok, --warn, --bad.">
          <Textarea
            rows={6}
            value={value.customCss ?? ''}
            onChange={(e) => set('customCss', e.target.value || undefined)}
            className="font-mono text-2xs"
            placeholder={'.banner { border-radius: 0 }\nh1 { font-size: 28px }'}
          />
        </Field>
      ) : (
        <button type="button" onClick={() => setShowCss(true)} className="text-xs text-[var(--accent)] underline-offset-2 hover:underline">
          Add custom CSS for a fully custom look
        </button>
      )}
    </fieldset>
  );
}
