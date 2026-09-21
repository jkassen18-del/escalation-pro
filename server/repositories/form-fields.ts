import { db, parseJson } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { FORM_FIELD_TYPES, type FormFieldType, type TeamFormField, type TicketFieldValue } from '../../shared/types.ts';

/**
 * Per-department intake forms.
 *
 * A team defines the questions its own tickets should answer; answers are
 * stored with a copy of the question, so a ticket still reads correctly after
 * the form is reworded or a field is retired.
 */

interface FieldRow {
  id: string;
  team_id: string;
  field_key: string;
  label: string;
  type: string;
  required: number | string;
  help_text: string | null;
  placeholder: string | null;
  options: string;
  position: number | string;
  data_source_id: string | null;
}

function mapField(row: FieldRow): TeamFormField {
  return {
    id: row.id,
    teamId: row.team_id,
    key: row.field_key,
    label: row.label,
    type: row.type as FormFieldType,
    required: Number(row.required) === 1,
    helpText: row.help_text,
    placeholder: row.placeholder,
    options: parseJson<string[]>(row.options, []),
    position: Number(row.position),
    dataSourceId: row.data_source_id,
  };
}

export async function listTeamFields(teamId: string): Promise<TeamFormField[]> {
  const rows = await db.all<FieldRow>(
    `SELECT * FROM team_form_fields WHERE team_id = ? ORDER BY position, label`,
    [teamId],
  );
  return rows.map(mapField);
}

/** Every team's fields at once, for pages that render more than one form. */
export async function listAllFields(): Promise<Record<string, TeamFormField[]>> {
  const rows = await db.all<FieldRow>(`SELECT * FROM team_form_fields ORDER BY position, label`);
  const byTeam: Record<string, TeamFormField[]> = {};
  for (const row of rows) {
    (byTeam[row.team_id] ??= []).push(mapField(row));
  }
  return byTeam;
}

/**
 * Derives a stable machine key from a label.
 *
 * Answers are stored against the key, so it is generated once and then left
 * alone - renaming "Order ID" to "Order reference" must not orphan every
 * answer already recorded under the old name.
 */
export function keyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'field';
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 500; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${randomId().slice(0, 6)}`;
}

export interface FormFieldInput {
  id?: string;
  key?: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  helpText?: string | null;
  placeholder?: string | null;
  options?: string[];
  dataSourceId?: string | null;
}

/**
 * Replaces a team's form in one go.
 *
 * The editor submits the whole form, so this diffs against what is stored:
 * fields keep their id (and therefore their answers) when they are still
 * present, and only genuinely removed ones are deleted.
 */
export async function replaceTeamForm(teamId: string, fields: FormFieldInput[]): Promise<TeamFormField[]> {
  if (fields.length > 40) throw badRequest('A form can have at most 40 fields.');

  const existing = await listTeamFields(teamId);
  const existingById = new Map(existing.map((field) => [field.id, field]));
  const now = new Date().toISOString();

  /*
   * Remove dropped fields first.
   *
   * The key is unique per team, so deleting afterwards would make a rename
   * done as "drop the old field, add one with the same label" collide with
   * the row still waiting to be removed.
   */
  const keptIds = fields
    .map((field) => field.id)
    .filter((id): id is string => Boolean(id) && existingById.has(id as string));
  for (const field of existing) {
    if (!keptIds.includes(field.id)) {
      await db.run(`DELETE FROM team_form_fields WHERE id = ?`, [field.id]);
    }
  }

  // Keys already in use by fields that are staying, so generated keys avoid them.
  const taken = new Set<string>(keptIds.map((id) => existingById.get(id)!.key));

  for (const [index, input] of fields.entries()) {
    const label = String(input.label ?? '').trim();
    if (!label) throw badRequest('Every field needs a label.');
    if (label.length > 120) throw badRequest(`"${label.slice(0, 20)}…" is too long for a label.`);
    if (!FORM_FIELD_TYPES.includes(input.type)) throw badRequest(`"${input.type}" is not a field type.`);

    const options = (input.options ?? []).map((option) => String(option).trim()).filter(Boolean).slice(0, 100);
    if ((input.type === 'select' || input.type === 'multiselect') && options.length === 0) {
      throw badRequest(`"${label}" is a choice field, so it needs at least one option.`);
    }
    if (input.type === 'lookup' && !input.dataSourceId) {
      throw badRequest(`"${label}" is a lookup field, so it needs a data source.`);
    }

    const previous = input.id ? existingById.get(input.id) : undefined;
    const key = previous?.key ?? keyFromLabel(input.key ?? label, taken);
    taken.add(key);

    const row = [
      label,
      input.type,
      input.required ? 1 : 0,
      input.helpText?.trim() || null,
      input.placeholder?.trim() || null,
      JSON.stringify(options),
      index,
      input.type === 'lookup' ? (input.dataSourceId ?? null) : null,
      now,
    ];

    if (previous) {
      await db.run(
        `UPDATE team_form_fields SET label = ?, type = ?, required = ?, help_text = ?, placeholder = ?,
           options = ?, position = ?, data_source_id = ?, updated_at = ? WHERE id = ?`,
        [...row, previous.id],
      );
    } else {
      const id = randomId();
      await db.run(
        `INSERT INTO team_form_fields (id, team_id, field_key, label, type, required, help_text, placeholder,
           options, position, data_source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, teamId, key, ...row.slice(0, 8), now, now],
      );
    }
  }

  return listTeamFields(teamId);
}

/* ------------------------------ answers ---------------------------------- */

const MAX_TEXT = 4000;

/**
 * Checks a submission against the team's form and returns what to store.
 *
 * Runs on the server because the form is data: a client can post whatever it
 * likes, including for a field marked required or an option that is not on
 * the list.
 */
export function validateAnswers(
  fields: TeamFormField[],
  submitted: Record<string, unknown>,
): Array<{ field: TeamFormField; value: unknown }> {
  const accepted: Array<{ field: TeamFormField; value: unknown }> = [];

  for (const field of fields) {
    const raw = submitted?.[field.key];
    const missing = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);

    if (missing) {
      if (field.required && field.type !== 'checkbox') {
        throw badRequest(`"${field.label}" is required.`, { [field.key]: 'Required' });
      }
      // An unticked checkbox is a real answer, not an absent one.
      if (field.type === 'checkbox') accepted.push({ field, value: false });
      continue;
    }

    switch (field.type) {
      case 'number': {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw badRequest(`"${field.label}" must be a number.`, { [field.key]: 'Not a number' });
        accepted.push({ field, value });
        break;
      }
      case 'checkbox': {
        accepted.push({ field, value: raw === true || raw === 'true' || raw === 1 || raw === '1' });
        break;
      }
      case 'date': {
        const text = String(raw);
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) {
          throw badRequest(`"${field.label}" is not a valid date.`, { [field.key]: 'Invalid date' });
        }
        accepted.push({ field, value: text });
        break;
      }
      case 'select': {
        const text = String(raw);
        if (!field.options.includes(text)) {
          throw badRequest(`"${text}" is not an option for "${field.label}".`, { [field.key]: 'Not an option' });
        }
        accepted.push({ field, value: text });
        break;
      }
      case 'multiselect': {
        const values = (Array.isArray(raw) ? raw : [raw]).map(String);
        const unknown = values.find((value) => !field.options.includes(value));
        if (unknown) {
          throw badRequest(`"${unknown}" is not an option for "${field.label}".`, { [field.key]: 'Not an option' });
        }
        accepted.push({ field, value: values });
        break;
      }
      case 'email': {
        const text = String(raw).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
          throw badRequest(`"${field.label}" must be an email address.`, { [field.key]: 'Invalid email' });
        }
        accepted.push({ field, value: text });
        break;
      }
      case 'url': {
        const text = String(raw).trim();
        // Parsed rather than pattern-matched, and restricted to web schemes so
        // a stored answer cannot become a javascript: link when rendered.
        try {
          const parsed = new URL(text);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme');
        } catch {
          throw badRequest(`"${field.label}" must be an http or https address.`, { [field.key]: 'Invalid URL' });
        }
        accepted.push({ field, value: text });
        break;
      }
      default: {
        // text, textarea and lookup are all stored as trimmed strings.
        const text = String(raw).trim();
        if (text.length > MAX_TEXT) {
          throw badRequest(`"${field.label}" is limited to ${MAX_TEXT} characters.`, { [field.key]: 'Too long' });
        }
        accepted.push({ field, value: text });
      }
    }
  }

  return accepted;
}

export async function saveAnswers(
  ticketId: string,
  answers: Array<{ field: TeamFormField; value: unknown }>,
): Promise<void> {
  await db.run(`DELETE FROM ticket_field_values WHERE ticket_id = ?`, [ticketId]);
  for (const { field, value } of answers) {
    await db.run(
      `INSERT INTO ticket_field_values (id, ticket_id, field_id, field_key, label, type, value, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomId(), ticketId, field.id, field.key, field.label, field.type, JSON.stringify(value), field.position],
    );
  }
}

export async function listAnswers(ticketId: string): Promise<TicketFieldValue[]> {
  const rows = await db.all<{
    field_id: string | null;
    field_key: string;
    label: string;
    type: string;
    value: string;
    position: number | string;
  }>(`SELECT field_id, field_key, label, type, value, position FROM ticket_field_values WHERE ticket_id = ? ORDER BY position`, [
    ticketId,
  ]);

  return rows.map((row) => ({
    fieldId: row.field_id,
    key: row.field_key,
    label: row.label,
    type: row.type as FormFieldType,
    value: parseJson<TicketFieldValue['value']>(row.value, null),
    position: Number(row.position),
  }));
}
