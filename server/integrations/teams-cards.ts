import type { Team, TeamFormField, TicketPriority } from '../../shared/types.ts';

/**
 * The ticket form, as an Adaptive Card.
 *
 * Teams has no slash commands for third-party apps - typing `/` opens Teams'
 * own palette, not ours - so the way in is `@InfraTicket finance`, or the
 * command list Teams shows when the bot is mentioned. Either way the reply is
 * this card, posted into the conversation, with the department's own
 * questions on it.
 *
 * Unlike Slack's modal there is no second round trip to refresh the card when
 * the department changes, so the department is resolved from what the person
 * typed and the card is built once, already knowing which questions to ask.
 */

/** Marks a submission so it can be told apart from any other card's. */
export const TICKET_CARD_ACTION = 'infraticket_new';

/** Every custom field's input id is prefixed, so answers are easy to collect. */
const FIELD_PREFIX = 'field:';

const PRIORITIES: Array<{ value: TicketPriority; title: string }> = [
  { value: 'urgent', title: 'Urgent' },
  { value: 'high', title: 'High' },
  { value: 'normal', title: 'Normal' },
  { value: 'low', title: 'Low' },
];

function labelBlock(field: TeamFormField) {
  return {
    type: 'TextBlock',
    text: field.required ? `${field.label} *` : field.label,
    wrap: true,
    weight: 'Bolder',
    spacing: 'Medium',
    size: 'Small',
  };
}

/**
 * One of the department's questions.
 *
 * Adaptive Cards enforce `isRequired` in the client only, so a required
 * answer is still checked on the server when the submission arrives - the
 * card is a convenience, not a control.
 */
function fieldInputs(field: TeamFormField): unknown[] {
  const id = `${FIELD_PREFIX}${field.key}`;
  const common = { id, isRequired: field.required, errorMessage: `${field.label} is required` };
  const blocks: unknown[] = [labelBlock(field)];

  if (field.helpText) {
    blocks.push({ type: 'TextBlock', text: field.helpText, wrap: true, isSubtle: true, size: 'Small' });
  }

  switch (field.type) {
    case 'textarea':
      blocks.push({ type: 'Input.Text', isMultiline: true, placeholder: field.placeholder ?? '', ...common });
      break;
    case 'number':
      blocks.push({ type: 'Input.Number', placeholder: field.placeholder ?? '', ...common });
      break;
    case 'date':
      blocks.push({ type: 'Input.Date', ...common });
      break;
    case 'checkbox':
      // A toggle is never "required": unticked is a real answer.
      blocks.push({ type: 'Input.Toggle', title: field.label, valueOn: 'true', valueOff: 'false', id });
      break;
    case 'email':
      blocks.push({ type: 'Input.Text', style: 'Email', placeholder: field.placeholder ?? '', ...common });
      break;
    case 'url':
      blocks.push({ type: 'Input.Text', style: 'Url', placeholder: field.placeholder ?? '', ...common });
      break;
    case 'select':
    case 'multiselect':
    case 'lookup': {
      if (field.options.length === 0) {
        blocks.push({ type: 'Input.Text', placeholder: field.placeholder ?? '', ...common });
        break;
      }
      blocks.push({
        type: 'Input.ChoiceSet',
        style: 'compact',
        isMultiSelect: field.type === 'multiselect',
        choices: field.options.map((choice) => ({ title: choice, value: choice })),
        ...common,
      });
      break;
    }
    default:
      blocks.push({ type: 'Input.Text', placeholder: field.placeholder ?? '', ...common });
  }

  return blocks;
}

export interface TicketCardOptions {
  team: Team;
  fields: TeamFormField[];
  /** Shown at the top so somebody knows which department they are writing to. */
  organizationName?: string;
}

export function buildTicketCard({ team, fields, organizationName }: TicketCardOptions) {
  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: `New ticket for ${team.name}`,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    },
    ...(organizationName
      ? [{ type: 'TextBlock', text: organizationName, isSubtle: true, size: 'Small', wrap: true }]
      : []),
    { type: 'TextBlock', text: 'Summary *', weight: 'Bolder', size: 'Small', spacing: 'Medium' },
    {
      type: 'Input.Text',
      id: 'subject',
      maxLength: 200,
      isRequired: true,
      errorMessage: 'Give it a one-line summary',
      placeholder: 'One line: what is wrong?',
    },
    { type: 'TextBlock', text: 'Details', weight: 'Bolder', size: 'Small', spacing: 'Medium' },
    { type: 'Input.Text', id: 'description', isMultiline: true },
    { type: 'TextBlock', text: 'Priority', weight: 'Bolder', size: 'Small', spacing: 'Medium' },
    {
      type: 'Input.ChoiceSet',
      id: 'priority',
      style: 'compact',
      value: 'normal',
      choices: PRIORITIES.map((p) => ({ title: p.title, value: p.value })),
    },
  ];

  for (const field of fields) body.push(...fieldInputs(field));

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    // 1.4 is the highest every Teams client in support renders, and is what
    // `isRequired` and `errorMessage` need.
    version: '1.4',
    body,
    actions: [
      {
        type: 'Action.Submit',
        title: 'Raise it',
        data: { action: TICKET_CARD_ACTION, teamId: team.id },
      },
    ],
  };
}

/** Wraps a card the way the Bot Framework expects an attachment. */
export function asAttachment(card: unknown) {
  return { contentType: 'application/vnd.microsoft.card.adaptive', content: card };
}

/* ---------------------------- Reading it back ----------------------------- */

export interface SubmittedCard {
  teamId: string | null;
  subject: string;
  description: string;
  priority: string;
  customFields: Record<string, unknown>;
}

/**
 * The `value` of a submitted card: one flat object keyed by input id.
 *
 * Adaptive Cards return everything as a string, including numbers and
 * toggles, so a toggle's 'true'/'false' is turned back into a boolean here
 * and everything else is left for the field validator to coerce and check.
 */
export function readCardSubmission(value: Record<string, unknown>): SubmittedCard {
  const customFields: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    const fieldKey = key.slice(FIELD_PREFIX.length);
    if (raw === 'true' || raw === 'false') {
      customFields[fieldKey] = raw === 'true';
      continue;
    }
    // A multi-select arrives as a comma-separated string.
    customFields[fieldKey] = typeof raw === 'string' && raw.includes(',') ? raw.split(',').map((s) => s.trim()) : raw;
  }

  return {
    teamId: typeof value.teamId === 'string' ? value.teamId : null,
    subject: String(value.subject ?? '').trim(),
    description: String(value.description ?? ''),
    priority: String(value.priority ?? 'normal'),
    customFields,
  };
}

/** A short card confirming what was raised, with a link to it. */
export function buildConfirmationCard(reference: string, subject: string, url: string) {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `Raised ${reference}`, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: subject, wrap: true },
    ],
    actions: [{ type: 'Action.OpenUrl', title: 'Open ticket', url }],
  };
}
