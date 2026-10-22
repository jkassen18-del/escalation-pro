import { db, parseJson, placeholders, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { keyFromLabel } from './form-fields.ts';
import { SEVERITIES } from '../../shared/ops.ts';
import {
  SCREENSHOT_MODES,
  TEMPLATE_ICONS,
  type ScreenshotMode,
  type TemplateField,
  type TemplateIcon,
  type TicketTemplate,
} from '../../shared/templates.ts';
import {
  FORM_FIELD_TYPES,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type FormFieldType,
  type PublicUser,
  type TeamFormField,
  type TicketPriority,
  type TicketType,
} from '../../shared/types.ts';

/**
 * Quick-ticket templates.
 *
 * A template fixes the parts of a ticket the person raising it should not have
 * to decide - department, type, priority, the questions to ask - so "the site
 * is down" becomes three fields and a screenshot instead of a full form.
 */

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  team_id: string | null;
  team_name?: string | null;
  ticket_type: string;
  priority: string;
  severity: string | null;
  subject_template: string;
  guidance: string | null;
  fields: string;
  screenshot: string;
  tags: string;
  audience_team_ids: string;
  enabled: number | string;
  position: number | string;
  created_at: string;
  updated_at: string;
}

function mapTemplate(row: TemplateRow): TicketTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: (TEMPLATE_ICONS as readonly string[]).includes(row.icon) ? (row.icon as TemplateIcon) : 'ticket',
    color: row.color,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    ticketType: row.ticket_type as TicketType,
    priority: row.priority as TicketPriority,
    severity: (row.severity as TicketTemplate['severity']) ?? null,
    subjectTemplate: row.subject_template,
    guidance: row.guidance,
    fields: parseJson<TemplateField[]>(row.fields, []),
    screenshot: row.screenshot as ScreenshotMode,
    tags: parseJson<string[]>(row.tags, []),
    audienceTeamIds: parseJson<string[]>(row.audience_team_ids, []),
    enabled: toBool(row.enabled),
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_TEMPLATE = `SELECT tt.*, t.name AS team_name FROM ticket_templates tt LEFT JOIN teams t ON t.id = tt.team_id`;

export async function listTemplates(): Promise<TicketTemplate[]> {
  const rows = await db.all<TemplateRow>(`${SELECT_TEMPLATE} ORDER BY tt.position, tt.name`);
  return rows.map(mapTemplate);
}

export async function findTemplate(id: string): Promise<TicketTemplate | null> {
  const row = await db.get<TemplateRow>(`${SELECT_TEMPLATE} WHERE tt.id = ?`, [id]);
  return row ? mapTemplate(row) : null;
}

/** Whether this person may raise a ticket from the template. */
export function canUseTemplate(template: TicketTemplate, user: PublicUser): boolean {
  if (!template.enabled || !template.teamId) return false;
  if (template.audienceTeamIds.length === 0) return true;
  return template.audienceTeamIds.some((teamId) => user.teamIds.includes(teamId));
}

/** As TeamFormField, so the department-form validation can check the answers. */
export function asFormFields(template: TicketTemplate): TeamFormField[] {
  return template.fields.map((field) => ({ ...field, teamId: template.teamId ?? '', dataSourceId: null }));
}

/* --------------------------------- Writes -------------------------------- */

export interface TemplateInput {
  name: string;
  description: string | null;
  icon: TemplateIcon;
  color: string;
  teamId: string;
  ticketType: TicketType;
  priority: TicketPriority;
  severity: TicketTemplate['severity'];
  subjectTemplate: string;
  guidance: string | null;
  fields: TemplateField[];
  screenshot: ScreenshotMode;
  tags: string[];
  audienceTeamIds: string[];
  enabled: boolean;
}

/** Lookup fields need a data source tied to a department form, so templates leave them out. */
const TEMPLATE_FIELD_TYPES: readonly FormFieldType[] = FORM_FIELD_TYPES.filter((type) => type !== 'lookup');

function validateFields(raw: unknown, previous: TemplateField[]): TemplateField[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > 20) throw badRequest('A quick ticket can ask at most 20 questions.');
  const previousById = new Map(previous.map((field) => [field.id, field]));
  const taken = new Set<string>(['summary', 'name', 'requester']);
  return list.map((item, index) => {
    const input = (item ?? {}) as Record<string, unknown>;
    const label = String(input.label ?? '').trim();
    if (!label) throw badRequest('Every question needs a label.');
    if (label.length > 120) throw badRequest(`"${label.slice(0, 20)}…" is too long for a label.`);
    const type = input.type as FormFieldType;
    if (!TEMPLATE_FIELD_TYPES.includes(type)) throw badRequest(`"${String(input.type)}" is not a question type here.`);
    const options = (Array.isArray(input.options) ? input.options : []).map((option) => String(option).trim()).filter(Boolean).slice(0, 100);
    if ((type === 'select' || type === 'multiselect') && options.length === 0) {
      throw badRequest(`"${label}" is a choice question, so it needs at least one option.`);
    }
    // A field keeps its key across edits, so earlier answers and the subject template stay valid.
    const kept = typeof input.id === 'string' ? previousById.get(input.id) : undefined;
    const key = kept?.key && !taken.has(kept.key) ? kept.key : keyFromLabel(String(input.key ?? label), taken);
    taken.add(key);
    return {
      id: kept?.id ?? `tf_${randomId().slice(0, 12)}`,
      key,
      label,
      type,
      required: Boolean(input.required),
      helpText: typeof input.helpText === 'string' && input.helpText.trim() ? input.helpText.trim().slice(0, 300) : null,
      placeholder: typeof input.placeholder === 'string' && input.placeholder.trim() ? input.placeholder.trim().slice(0, 200) : null,
      options,
      position: index,
    };
  });
}

export function validateTemplate(body: Record<string, unknown>, previous?: TicketTemplate): TemplateInput {
  const name = String(body.name ?? '').trim().slice(0, 80);
  if (!name) throw badRequest('Give the quick ticket a name.', { name: 'Required' });
  const teamId = typeof body.teamId === 'string' ? body.teamId : '';
  if (!teamId) throw badRequest('Choose the department it goes to.', { teamId: 'Required' });
  const ticketType = TICKET_TYPES.includes(body.ticketType as TicketType) ? (body.ticketType as TicketType) : 'request';
  const priority = TICKET_PRIORITIES.includes(body.priority as TicketPriority) ? (body.priority as TicketPriority) : 'normal';
  const severity =
    ticketType === 'incident' && (SEVERITIES as readonly string[]).includes(String(body.severity)) ? (body.severity as TicketTemplate['severity']) : null;
  const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#6b7280';
  const subjectTemplate = String(body.subjectTemplate ?? '').trim().slice(0, 200) || '{{name}}: {{summary}}';
  return {
    name,
    description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 300) : null,
    icon: (TEMPLATE_ICONS as readonly string[]).includes(String(body.icon)) ? (body.icon as TemplateIcon) : 'ticket',
    color,
    teamId,
    ticketType,
    priority,
    severity,
    subjectTemplate,
    guidance: typeof body.guidance === 'string' && body.guidance.trim() ? body.guidance.trim().slice(0, 2000) : null,
    fields: validateFields(body.fields, previous?.fields ?? []),
    screenshot: SCREENSHOT_MODES.includes(body.screenshot as ScreenshotMode) ? (body.screenshot as ScreenshotMode) : 'encouraged',
    tags: (Array.isArray(body.tags) ? body.tags : [])
      .map((tag) => String(tag).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10),
    audienceTeamIds: (Array.isArray(body.audienceTeamIds) ? body.audienceTeamIds : []).map(String).slice(0, 50),
    enabled: body.enabled !== false,
  };
}

async function assertTeamsExist(ids: string[]): Promise<void> {
  const unique = Array.from(new Set(ids));
  if (!unique.length) return;
  const rows = await db.all<{ id: string }>(`SELECT id FROM teams WHERE id IN (${placeholders(unique.length)})`, unique);
  if (rows.length !== unique.length) throw badRequest('One of the chosen teams no longer exists.');
}

export async function saveTemplate(id: string | null, input: TemplateInput, userId: string): Promise<TicketTemplate> {
  await assertTeamsExist([input.teamId, ...input.audienceTeamIds]);
  const now = new Date().toISOString();
  const values = [
    input.name,
    input.description,
    input.icon,
    input.color,
    input.teamId,
    input.ticketType,
    input.priority,
    input.severity,
    input.subjectTemplate,
    input.guidance,
    JSON.stringify(input.fields),
    input.screenshot,
    JSON.stringify(input.tags),
    JSON.stringify(input.audienceTeamIds),
    input.enabled ? 1 : 0,
  ];
  if (id) {
    await db.run(
      `UPDATE ticket_templates SET name = ?, description = ?, icon = ?, color = ?, team_id = ?, ticket_type = ?, priority = ?,
         severity = ?, subject_template = ?, guidance = ?, fields = ?, screenshot = ?, tags = ?, audience_team_ids = ?,
         enabled = ?, updated_at = ? WHERE id = ?`,
      [...values, now, id],
    );
    return (await findTemplate(id))!;
  }
  const templateId = randomId();
  const last = await db.get<{ n: number | string | null }>(`SELECT MAX(position) AS n FROM ticket_templates`);
  await db.run(
    `INSERT INTO ticket_templates (id, name, description, icon, color, team_id, ticket_type, priority, severity, subject_template,
       guidance, fields, screenshot, tags, audience_team_ids, enabled, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [templateId, ...values, Number(last?.n ?? -1) + 1, userId, now, now],
  );
  return (await findTemplate(templateId))!;
}

export async function deleteTemplate(id: string): Promise<void> {
  // Tickets keep their template_id for history; the name simply stops resolving.
  await db.run(`DELETE FROM ticket_templates WHERE id = ?`, [id]);
}

/* ------------------------------ The subject ------------------------------ */

function answerText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/**
 * Fills "Site issue: {{site}}" from the answers. A placeholder with no answer
 * is dropped along with the separator it leaves dangling, so an unanswered
 * optional question never shows up as "Site issue: " or "{{site}}".
 */
export function renderSubject(template: TicketTemplate, answers: Record<string, unknown>, extras: { summary?: string; requester?: string }): string {
  const values: Record<string, string> = { name: template.name, summary: extras.summary ?? '', requester: extras.requester ?? '' };
  for (const field of template.fields) values[field.key] = answerText(answers[field.key]).replace(/\s+/g, ' ').trim();
  const filled = template.subjectTemplate.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => values[key.toLowerCase()] ?? '');
  const tidy = filled
    .replace(/\s+/g, ' ')
    .replace(/(\s*[-:|·,–—]\s*)+$/u, '')
    .replace(/^(\s*[-:|·,–—]\s*)+/u, '')
    .replace(/\(\s*\)/g, '')
    .trim();
  return (tidy || template.name).slice(0, 200);
}
