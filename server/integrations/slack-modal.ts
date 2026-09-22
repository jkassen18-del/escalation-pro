import type { Team, TeamFormField, TicketPriority } from '../../shared/types.ts';

/**
 * The ticket form, as a Slack modal.
 *
 * The point of the slash command is that somebody in Slack never has to leave
 * it, so the modal has to ask exactly what the web form asks - including the
 * department's own questions, which are data and differ per team. That means
 * the view is built from `team_form_fields` at the moment it opens, not
 * hard-coded, and is rebuilt when the person switches department.
 */

/** Marks the view so a submission can be told apart from any other modal. */
export const TICKET_MODAL_CALLBACK = 'infraticket_new';

/** The department picker's own ids, which the update handler watches for. */
export const TEAM_BLOCK = 'team_block';
export const TEAM_ACTION = 'team_select';

/** Every custom field's block id is prefixed, so answers are easy to collect. */
const FIELD_PREFIX = 'field:';

const PRIORITIES: Array<{ value: TicketPriority; label: string }> = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

const option = (text: string, value: string) => ({
  text: { type: 'plain_text', text: text.slice(0, 75), emoji: true },
  value,
});

/**
 * One of the department's questions, as a Slack input block.
 *
 * Slack has no equivalent of some field types, so they degrade rather than
 * disappear: a lookup with more choices than Slack will render becomes a text
 * box, and the answer is still validated against the real field on submit.
 */
function fieldBlock(field: TeamFormField): Record<string, unknown> | null {
  const base = {
    type: 'input',
    block_id: `${FIELD_PREFIX}${field.key}`,
    optional: !field.required,
    label: { type: 'plain_text', text: field.label.slice(0, 2000), emoji: true },
    ...(field.helpText ? { hint: { type: 'plain_text', text: field.helpText.slice(0, 2000) } } : {}),
  };

  const placeholder = field.placeholder
    ? { placeholder: { type: 'plain_text', text: field.placeholder.slice(0, 150) } }
    : {};

  switch (field.type) {
    case 'textarea':
      return { ...base, element: { type: 'plain_text_input', multiline: true, action_id: 'v', ...placeholder } };
    case 'number':
      return { ...base, element: { type: 'number_input', is_decimal_allowed: true, action_id: 'v' } };
    case 'date':
      return { ...base, element: { type: 'datepicker', action_id: 'v' } };
    case 'email':
      return { ...base, element: { type: 'email_text_input', action_id: 'v', ...placeholder } };
    case 'url':
      return { ...base, element: { type: 'url_text_input', action_id: 'v', ...placeholder } };
    case 'checkbox':
      return {
        ...base,
        // A checkbox is never "required" in Slack's sense: unticked is an answer.
        optional: true,
        element: { type: 'checkboxes', action_id: 'v', options: [option('Yes', 'true')] },
      };
    case 'select':
    case 'multiselect':
    case 'lookup': {
      // Slack renders at most 100 options; beyond that a text box is honest.
      if (field.options.length === 0 || field.options.length > 100) {
        return { ...base, element: { type: 'plain_text_input', action_id: 'v', ...placeholder } };
      }
      return {
        ...base,
        element: {
          type: field.type === 'multiselect' ? 'multi_static_select' : 'static_select',
          action_id: 'v',
          options: field.options.map((choice) => option(choice, choice)),
        },
      };
    }
    default:
      return { ...base, element: { type: 'plain_text_input', action_id: 'v', ...placeholder } };
  }
}

export interface ModalOptions {
  teams: Team[];
  selectedTeam: Team | null;
  fields: TeamFormField[];
  /** Carried through the modal so the ticket can be announced where it started. */
  channelId?: string;
}

export function buildTicketModal({ teams, selectedTeam, fields, channelId }: ModalOptions) {
  const blocks: unknown[] = [
    {
      type: 'input',
      block_id: TEAM_BLOCK,
      // Re-opens the view with this department's questions as soon as it changes.
      dispatch_action: true,
      label: { type: 'plain_text', text: 'Department' },
      element: {
        type: 'static_select',
        action_id: TEAM_ACTION,
        placeholder: { type: 'plain_text', text: 'Choose a department' },
        options: teams.map((team) => option(`${team.name} (${team.key})`, team.id)),
        ...(selectedTeam ? { initial_option: option(`${selectedTeam.name} (${selectedTeam.key})`, selectedTeam.id) } : {}),
      },
    },
    {
      type: 'input',
      block_id: 'subject',
      label: { type: 'plain_text', text: 'Summary' },
      element: {
        type: 'plain_text_input',
        action_id: 'v',
        max_length: 200,
        placeholder: { type: 'plain_text', text: 'One line: what is wrong?' },
      },
    },
    {
      type: 'input',
      block_id: 'description',
      optional: true,
      label: { type: 'plain_text', text: 'Details' },
      element: { type: 'plain_text_input', multiline: true, action_id: 'v' },
    },
    {
      type: 'input',
      block_id: 'priority',
      label: { type: 'plain_text', text: 'Priority' },
      element: {
        type: 'static_select',
        action_id: 'v',
        options: PRIORITIES.map((p) => option(p.label, p.value)),
        initial_option: option('Normal', 'normal'),
      },
    },
  ];

  if (!selectedTeam) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Pick a department and its own questions will appear here.',
        },
      ],
    });
  }

  const custom = fields.map(fieldBlock).filter(Boolean) as Record<string, unknown>[];
  if (custom.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${selectedTeam?.name ?? 'This department'} asks:*` }],
    });
    // Slack caps a view at 100 blocks; the fixed ones above take five.
    blocks.push(...custom.slice(0, 90));
  }

  return {
    type: 'modal',
    callback_id: TICKET_MODAL_CALLBACK,
    // Survives the round trip so the submission knows where it was raised.
    private_metadata: JSON.stringify({ channelId: channelId ?? null }),
    title: { type: 'plain_text', text: 'New ticket' },
    submit: { type: 'plain_text', text: 'Raise it' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/* ---------------------------- Reading it back ----------------------------- */

export interface ViewStateValue {
  type?: string;
  value?: string | null;
  selected_option?: { value?: string } | null;
  selected_options?: Array<{ value?: string }> | null;
  selected_date?: string | null;
}

export type ViewState = { values?: Record<string, Record<string, ViewStateValue>> };

/** A modal as Slack sends it back, on an action inside it or on submission. */
export interface SlackView {
  id?: string;
  /** Slack rejects a views.update carrying a stale hash. */
  hash?: string;
  callback_id?: string;
  private_metadata?: string;
  state?: ViewState;
}

/** Whatever the person actually put in one input, whichever kind it was. */
function readValue(entry: ViewStateValue | undefined): unknown {
  if (!entry) return undefined;
  if (entry.selected_date != null) return entry.selected_date;
  if (entry.selected_option) return entry.selected_option.value;
  if (entry.selected_options) {
    // Checkboxes and multi-selects share this shape; a lone 'true' is a tick.
    const values = entry.selected_options.map((choice) => choice.value).filter(Boolean);
    if (entry.type === 'checkboxes') return values.includes('true');
    return values;
  }
  return entry.value ?? undefined;
}

export interface SubmittedTicket {
  teamId: string | null;
  subject: string;
  description: string;
  priority: string;
  customFields: Record<string, unknown>;
  channelId: string | null;
}

export function readSubmission(view: SlackView): SubmittedTicket {
  const values = view.state?.values ?? {};
  const first = (block: string) => readValue(Object.values(values[block] ?? {})[0]);

  const customFields: Record<string, unknown> = {};
  for (const [blockId, actions] of Object.entries(values)) {
    if (!blockId.startsWith(FIELD_PREFIX)) continue;
    const value = readValue(Object.values(actions)[0]);
    if (value !== undefined) customFields[blockId.slice(FIELD_PREFIX.length)] = value;
  }

  let channelId: string | null = null;
  try {
    channelId = (JSON.parse(view.private_metadata || '{}') as { channelId?: string }).channelId ?? null;
  } catch {
    // Absent or malformed metadata just means we do not know the channel.
  }

  return {
    teamId: (first(TEAM_BLOCK) as string) ?? null,
    subject: String(first('subject') ?? '').trim(),
    description: String(first('description') ?? ''),
    priority: String(first('priority') ?? 'normal'),
    customFields,
    channelId,
  };
}
