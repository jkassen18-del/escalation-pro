import { db, parseJson, toBool } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { SEVERITIES, type AlertRule, type AlertRuleActions, type AlertRuleMatch, type RoutingOutcome, type Severity } from '../../shared/ops.ts';
import { readPath } from './sources.ts';

/**
 * Alert routing rules.
 *
 * Evaluated in order for every new alert, before the default routing (the
 * source's own escalation policy, then its team's). The first rule that
 * matches decides, unless it says to keep going, in which case later matching
 * rules add their tags and override what they set. A rule can send the
 * incident to a department, page a different policy, change the severity,
 * open a ticket without paging anyone, or drop the alert altogether.
 */

/** The parts of a signal a rule can look at. */
export interface RoutableSignal {
  sourceType: 'monitor' | 'webhook';
  sourceId: string;
  /** Monitor kind (http, database...) or alert source kind (aws_sns, jenkins...). */
  sourceKind?: string;
  title: string;
  summary?: string;
  severity: Severity;
  payload?: unknown;
  teamId: string | null;
  escalationPolicyId: string | null;
}

interface RuleRow {
  id: string;
  name: string;
  position: number | string;
  enabled: number | string;
  match_spec: string;
  actions: string;
  continue_evaluating: number | string;
  created_at: string;
  updated_at: string;
}

function mapRule(row: RuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    position: Number(row.position),
    enabled: toBool(row.enabled),
    match: parseJson<AlertRuleMatch>(row.match_spec, {}),
    actions: parseJson<AlertRuleActions>(row.actions, {}),
    continueEvaluating: toBool(row.continue_evaluating),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRules(): Promise<AlertRule[]> {
  return (await db.all<RuleRow>(`SELECT * FROM alert_rules ORDER BY position, created_at`)).map(mapRule);
}

export async function getRule(id: string): Promise<AlertRule | null> {
  const row = await db.get<RuleRow>(`SELECT * FROM alert_rules WHERE id = ?`, [id]);
  return row ? mapRule(row) : null;
}

/* ------------------------------- Validation ------------------------------ */

const MAX_PATTERN = 200;

/**
 * JavaScript regexes have no timeout, so a pattern like (a+)+ against a long
 * title can stall the alert pipeline. Nested quantifiers are refused, and
 * the text a pattern runs against is capped.
 */
export function assertSafeRegex(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN) throw badRequest(`Keep patterns under ${MAX_PATTERN} characters.`);
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /\\[1-9]/.test(pattern)) {
    throw badRequest('That pattern repeats a repeated group (or uses a back-reference), which can hang the alert pipeline. Simplify it.');
  }
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw badRequest(`Not a valid pattern: ${(error as Error).message}`);
  }
}

const strings = (value: unknown, max = 50) =>
  Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, max) : undefined;

export function validateRule(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the rule a name.', { name: 'Required' });
  const m = (body.match ?? {}) as Record<string, unknown>;
  const a = (body.actions ?? {}) as Record<string, unknown>;

  const match: AlertRuleMatch = {};
  const sourceIds = strings(m.sourceIds);
  if (sourceIds?.length) match.sourceIds = sourceIds;
  const sourceKinds = strings(m.sourceKinds);
  if (sourceKinds?.length) match.sourceKinds = sourceKinds;
  const text = typeof m.text === 'string' ? m.text.trim().slice(0, MAX_PATTERN) : '';
  if (text) {
    match.text = text;
    match.textMode = m.textMode === 'regex' ? 'regex' : 'contains';
    if (match.textMode === 'regex') assertSafeRegex(text);
  }
  const severities = strings(m.severities)?.filter((s): s is Severity => (SEVERITIES as readonly string[]).includes(s));
  if (severities?.length) match.severities = severities;
  const field = m.field as Record<string, unknown> | undefined;
  if (field && typeof field.path === 'string' && field.path.trim()) {
    match.field = {
      path: field.path.trim().slice(0, 200),
      op: field.op === 'contains' ? 'contains' : 'equals',
      value: String(field.value ?? '').slice(0, 500),
    };
  }
  const window = m.timeWindow as Record<string, unknown> | undefined;
  if (window && (window.mode === 'business_hours' || window.mode === 'after_hours')) {
    const timeZone = String(window.timeZone || 'Africa/Johannesburg');
    try {
      new Intl.DateTimeFormat('en', { timeZone });
    } catch {
      throw badRequest(`"${timeZone}" is not a time zone.`);
    }
    const days = (Array.isArray(window.days) ? window.days.map(Number) : [1, 2, 3, 4, 5]).filter((d) => d >= 0 && d <= 6);
    const startHour = Math.min(23, Math.max(0, Math.round(Number(window.startHour ?? 8))));
    const endHour = Math.min(24, Math.max(1, Math.round(Number(window.endHour ?? 17))));
    if (endHour <= startHour) throw badRequest('Working hours must end after they start.');
    match.timeWindow = { mode: window.mode, timeZone, days, startHour, endHour };
  }

  const actions: AlertRuleActions = {};
  if (typeof a.teamId === 'string' && a.teamId) actions.teamId = a.teamId;
  if (typeof a.escalationPolicyId === 'string' && a.escalationPolicyId) actions.escalationPolicyId = a.escalationPolicyId;
  if ((SEVERITIES as readonly string[]).includes(String(a.severity))) actions.severity = a.severity as Severity;
  const tags = strings(a.tags, 10)?.map((t) => t.toLowerCase().slice(0, 40));
  if (tags?.length) actions.tags = tags;
  if (a.suppressPaging === true) actions.suppressPaging = true;
  if (a.drop === true) actions.drop = true;
  if (!Object.keys(actions).length) throw badRequest('A rule needs at least one action.');

  return { name, enabled: body.enabled !== false, match, actions, continueEvaluating: body.continueEvaluating === true };
}

export async function saveRule(id: string | null, input: ReturnType<typeof validateRule>): Promise<AlertRule> {
  const now = new Date().toISOString();
  if (id) {
    await db.run(`UPDATE alert_rules SET name = ?, enabled = ?, match_spec = ?, actions = ?, continue_evaluating = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      input.enabled ? 1 : 0,
      JSON.stringify(input.match),
      JSON.stringify(input.actions),
      input.continueEvaluating ? 1 : 0,
      now,
      id,
    ]);
    return (await getRule(id))!;
  }
  const last = await db.get<{ n: number | string | null }>(`SELECT MAX(position) AS n FROM alert_rules`);
  const ruleId = randomId();
  await db.run(
    `INSERT INTO alert_rules (id, name, position, enabled, match_spec, actions, continue_evaluating, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ruleId,
      input.name,
      last?.n === null || last?.n === undefined ? 0 : Number(last.n) + 1,
      input.enabled ? 1 : 0,
      JSON.stringify(input.match),
      JSON.stringify(input.actions),
      input.continueEvaluating ? 1 : 0,
      now,
      now,
    ],
  );
  return (await getRule(ruleId))!;
}

/** Sets the order to exactly the ids given; rules left out keep their place after them. */
export async function reorderRules(ids: string[]): Promise<AlertRule[]> {
  const rules = await listRules();
  const known = new Set(rules.map((r) => r.id));
  const ordered = [...ids.filter((id) => known.has(id)), ...rules.map((r) => r.id).filter((id) => !ids.includes(id))];
  await db.transaction(async () => {
    for (const [index, id] of ordered.entries()) await db.run(`UPDATE alert_rules SET position = ? WHERE id = ?`, [index, id]);
  });
  return listRules();
}

/* ------------------------------- Evaluation ------------------------------ */

/** Weekday (0 = Sunday) and hour in a time zone. */
export function localTime(at: Date, timeZone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday), hour };
}

export function ruleMatches(match: AlertRuleMatch, signal: RoutableSignal, at: Date = new Date()): boolean {
  if (match.sourceIds?.length && !match.sourceIds.includes(signal.sourceId)) return false;
  if (match.sourceKinds?.length && !match.sourceKinds.includes(signal.sourceKind ?? '') && !match.sourceKinds.includes(signal.sourceType)) return false;
  if (match.severities?.length && !match.severities.includes(signal.severity)) return false;
  if (match.text) {
    // Title and summary are tested separately, so ^ and $ mean what they look like.
    const fields = [signal.title, signal.summary ?? ''].map((field) => field.slice(0, 2000));
    if (match.textMode === 'regex') {
      let pattern: RegExp;
      try {
        pattern = assertSafeRegex(match.text);
      } catch {
        return false;
      }
      if (!fields.some((field) => pattern.test(field))) return false;
    } else if (!fields.some((field) => field.toLowerCase().includes(match.text!.toLowerCase()))) {
      return false;
    }
  }
  if (match.field) {
    const raw = readPath(signal.payload, match.field.path);
    if (raw === undefined || raw === null) return false;
    const value = (typeof raw === 'string' ? raw : JSON.stringify(raw)).toLowerCase();
    const wanted = match.field.value.toLowerCase();
    if (match.field.op === 'equals' ? value !== wanted : !value.includes(wanted)) return false;
  }
  if (match.timeWindow) {
    const { day, hour } = localTime(at, match.timeWindow.timeZone);
    const inside = match.timeWindow.days.includes(day) && hour >= match.timeWindow.startHour && hour < match.timeWindow.endHour;
    if (match.timeWindow.mode === 'business_hours' ? !inside : inside) return false;
  }
  return true;
}

/** Applies the rules to a signal. Pure: nothing is written. */
export function evaluateRules(rules: AlertRule[], signal: RoutableSignal, at: Date = new Date()): RoutingOutcome {
  const outcome: RoutingOutcome = {
    matchedRules: [],
    teamId: signal.teamId,
    escalationPolicyId: signal.escalationPolicyId,
    severity: signal.severity,
    tags: [],
    suppressPaging: false,
    drop: false,
    explanation: 'No routing rule matched; the source\'s own routing applies.',
  };
  const notes: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule.match, signal, at)) continue;
    outcome.matchedRules.push({ id: rule.id, name: rule.name });
    const a = rule.actions;
    if (a.teamId) {
      outcome.teamId = a.teamId;
      // A different department means its own default policy, unless the rule names one.
      if (!a.escalationPolicyId) outcome.escalationPolicyId = null;
    }
    if (a.escalationPolicyId) outcome.escalationPolicyId = a.escalationPolicyId;
    if (a.severity) {
      notes.push(`severity ${outcome.severity.toUpperCase()} → ${a.severity.toUpperCase()}`);
      outcome.severity = a.severity;
    }
    for (const tag of a.tags ?? []) if (!outcome.tags.includes(tag)) outcome.tags.push(tag);
    if (a.suppressPaging) outcome.suppressPaging = true;
    if (a.drop) outcome.drop = true;
    if (!rule.continueEvaluating) break;
  }
  if (outcome.matchedRules.length) {
    const names = outcome.matchedRules.map((r) => `'${r.name}'`).join(', then ');
    outcome.explanation = outcome.drop
      ? `Dropped by rule ${names}.`
      : `Routed by rule ${names}${notes.length ? ` (${notes.join(', ')})` : ''}${outcome.suppressPaging ? '; paging suppressed' : ''}.`;
  }
  return outcome;
}

export async function routeSignal(signal: RoutableSignal, at: Date = new Date()): Promise<RoutingOutcome> {
  return evaluateRules(await listRules(), signal, at);
}
