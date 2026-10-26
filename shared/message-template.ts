/**
 * How a ticket notification looks in Slack, Microsoft Teams and Linear.
 *
 * One small template per provider, stored on the integration. The server fills
 * it in when it sends; the settings screen fills the same template with a
 * sample ticket for its live preview, so what is previewed is what is sent.
 */

export const TEMPLATE_PROVIDERS = ['slack', 'msteams', 'linear'] as const;
export type TemplateProvider = (typeof TEMPLATE_PROVIDERS)[number];

/** The facts that can be shown as label/value pairs under the title. */
export const TEMPLATE_FIELDS = ['status', 'priority', 'type', 'team', 'assignee', 'requester', 'labels', 'due', 'severity', 'source', 'created'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export const TEMPLATE_FIELD_LABELS: Record<TemplateField, string> = {
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  team: 'Team',
  assignee: 'Assignee',
  requester: 'Requester',
  labels: 'Labels',
  due: 'Due',
  severity: 'Severity',
  source: 'Raised via',
  created: 'Opened',
};

export interface MessageTemplate {
  /** Bold first line. */
  title: string;
  /** Second line, under the title. */
  subtitle: string;
  /** Label/value pairs, in this order. */
  fields: TemplateField[];
  /** Free text under the fields; may be blank. */
  body: string;
  /** Small print at the bottom; may be blank. */
  footer: string;
  /** Slack: Open / Resolve / Close buttons. Teams: the Open ticket button. Ignored by Linear. */
  buttons: boolean;
  /** Slack and Teams: a coloured edge by priority. */
  priorityColour: boolean;
}

/** Placeholders, with what they are replaced by. Shown as help in the editor. */
export const TEMPLATE_PLACEHOLDERS: Array<{ key: string; label: string }> = [
  { key: 'headline', label: 'What happened, e.g. "New urgent incident: ESC-1042"' },
  { key: 'reference', label: 'ESC-1042' },
  { key: 'ticket_link', label: 'The reference as a link to the ticket' },
  { key: 'subject', label: 'The ticket subject' },
  { key: 'description', label: 'The ticket description, as plain text' },
  { key: 'detail', label: 'What changed: the comment, the new status, the escalation reason' },
  { key: 'status', label: 'Open, In progress…' },
  { key: 'priority', label: 'Urgent, High, Normal, Low' },
  { key: 'type', label: 'Incident, Request…' },
  { key: 'team', label: 'The department' },
  { key: 'assignee', label: 'Who it is assigned to' },
  { key: 'requester', label: 'Who raised it' },
  { key: 'actor', label: 'Who made this change' },
  { key: 'labels', label: 'Its labels, comma separated' },
  { key: 'due', label: 'When the SLA is due' },
  { key: 'url', label: 'The ticket address' },
  { key: 'time', label: 'When this was sent' },
  { key: 'org', label: 'Your organisation name' },
];

export const DEFAULT_TEMPLATES: Record<TemplateProvider, MessageTemplate> = {
  slack: {
    title: '{{headline}}',
    subtitle: '{{ticket_link}} · {{subject}}',
    fields: ['status', 'priority', 'team', 'assignee'],
    body: '{{detail}}',
    footer: 'Updated by {{actor}} · {{time}}',
    buttons: true,
    priorityColour: true,
  },
  msteams: {
    title: '{{headline}}',
    subtitle: '{{subject}}',
    fields: ['status', 'priority', 'team', 'assignee'],
    body: '{{detail}}',
    footer: 'Updated by {{actor}} · {{time}}',
    buttons: true,
    priorityColour: true,
  },
  linear: {
    title: '[{{reference}}] {{subject}}',
    subtitle: '',
    fields: ['team', 'priority', 'requester'],
    body: '{{description}}',
    footer: 'Escalated from {{ticket_link}} in {{org}}.',
    buttons: false,
    priorityColour: false,
  },
};

const LIMITS = { title: 200, subtitle: 300, body: 2000, footer: 300 };

/** Accepts whatever was stored or posted and returns a complete, bounded template. */
export function normaliseTemplate(provider: TemplateProvider, value: unknown): MessageTemplate {
  const base = DEFAULT_TEMPLATES[provider];
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = (key: keyof typeof LIMITS) => (typeof input[key] === 'string' ? (input[key] as string).slice(0, LIMITS[key]) : base[key]);
  const fields = Array.isArray(input.fields)
    ? (input.fields.filter((field, index, all) => (TEMPLATE_FIELDS as readonly unknown[]).includes(field) && all.indexOf(field) === index) as TemplateField[])
    : base.fields;
  return {
    title: text('title').trim() || base.title,
    subtitle: text('subtitle'),
    fields,
    body: text('body'),
    footer: text('footer'),
    buttons: typeof input.buttons === 'boolean' ? input.buttons : base.buttons,
    priorityColour: typeof input.priorityColour === 'boolean' ? input.priorityColour : base.priorityColour,
  };
}

/** The ticket facts a template can use; built from a ticket on the server, from a sample in the preview. */
export interface TemplateValues {
  headline: string;
  reference: string;
  subject: string;
  description: string;
  detail: string;
  status: string;
  priority: string;
  type: string;
  team: string;
  assignee: string;
  requester: string;
  actor: string;
  labels: string;
  due: string;
  severity: string;
  source: string;
  created: string;
  url: string;
  time: string;
  org: string;
}

/** How each provider writes a link; `escape` protects ticket text from being read as markup. */
export const DIALECTS: Record<TemplateProvider, { link: (text: string, url: string) => string; escape: (text: string) => string }> = {
  slack: {
    link: (text, url) => `<${url}|${text}>`,
    escape: (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  },
  msteams: { link: (text, url) => `[${text}](${url})`, escape: (text) => text },
  linear: { link: (text, url) => `[${text}](${url})`, escape: (text) => text },
};

/**
 * Fills `{{placeholders}}`. Ticket values are escaped for the provider; the
 * template's own text is not, so an admin can use Slack's *bold* or Markdown.
 * Unknown placeholders are left visible, so a typo shows up in the preview.
 */
export function fill(template: string, values: TemplateValues, provider: TemplateProvider): string {
  const dialect = DIALECTS[provider];
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
      if (key === 'ticket_link') return dialect.link(dialect.escape(values.reference), values.url);
      if (key in values) return dialect.escape(String(values[key as keyof TemplateValues] ?? ''));
      return whole;
    })
    .trim();
}

/** The fields the template asks for, as label/value pairs, skipping any with nothing to say. */
export function fieldPairs(template: MessageTemplate, values: TemplateValues, provider: TemplateProvider): Array<{ label: string; value: string }> {
  const escape = DIALECTS[provider].escape;
  return template.fields
    .map((field) => ({ label: TEMPLATE_FIELD_LABELS[field], value: values[field] }))
    .filter((pair) => pair.value && pair.value !== '—')
    .map((pair) => ({ label: pair.label, value: escape(pair.value) }));
}

/** A believable ticket for the settings preview. */
export const SAMPLE_VALUES: TemplateValues = {
  headline: 'New normal request: ESC-1007',
  reference: 'ESC-1007',
  subject: 'Withdrawal Flush Request',
  description: 'Player 48213 has three pending withdrawals stuck since this morning. Please flush the queue.',
  detail: 'Player 48213 has three pending withdrawals stuck since this morning.',
  status: 'Open',
  priority: 'Normal',
  type: 'Request',
  team: 'Finance (Withdrawals)',
  assignee: 'Unassigned',
  requester: 'Jamal Kassen',
  actor: 'Jamal Kassen',
  labels: 'Withdrawals, VIP',
  due: '27 Oct 05:55',
  severity: '',
  source: 'Slack',
  created: '26 Oct 05:55',
  url: 'https://tickets.example.com/tickets/1007',
  time: 'Mon, 26 Oct 2026 05:55',
  org: 'Gold Media Lab',
};
