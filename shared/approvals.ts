/**
 * Approvals: "needs sign-off by X before work starts".
 *
 * A rule says which new tickets need sign-off (Marketing artwork, a Finance
 * payment over a limit, an access request) and who gives it. A request can
 * also be made by hand from a ticket. While one is waiting, the ticket cannot
 * be started or resolved; a rejection closes it (or leaves it open, if the
 * rule says so).
 */

/** Who signs off. Resolved to people when the request is made. */
export type ApproverSpec =
  | { kind: 'user'; userId: string }
  /** The ticket's department managers. */
  | { kind: 'department_managers' }
  /** Whoever leads the department's shift when the request is made. */
  | { kind: 'shift_leader' }
  /** Everyone holding a role, e.g. "Finance approvers". */
  | { kind: 'role'; roleId: string };

export const APPROVAL_FIELD_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'contains'] as const;
export type ApprovalFieldOp = (typeof APPROVAL_FIELD_OPS)[number];

/** Every condition given must hold; an empty set matches every ticket in the rule's scope. */
export interface ApprovalConditions {
  types?: string[];
  priorities?: string[];
  /** Any of these labels. */
  tags?: string[];
  /** Any of these words in the subject or description. */
  keywords?: string[];
  /** Raised from one of these quick-ticket templates. */
  templateIds?: string[];
  /** A department form answer, e.g. amount gt 50000. */
  field?: { key: string; op: ApprovalFieldOp; value: string } | null;
}

export type ApprovalMode = 'any' | 'all';

export interface ApprovalRule {
  id: string;
  /** Null: organisation-wide. */
  teamId: string | null;
  name: string;
  enabled: boolean;
  conditions: ApprovalConditions;
  approvers: ApproverSpec[];
  mode: ApprovalMode;
  /** What a rejection does to the ticket. */
  onReject: 'close' | 'keep_open';
  position: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalDecision {
  userId: string;
  name: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  at: string;
  /** web, slack, teams or email. */
  via: string;
}

export interface TicketApproval {
  id: string;
  ticketId: string;
  ruleId: string | null;
  title: string;
  note: string | null;
  approverIds: string[];
  approverNames: string[];
  mode: ApprovalMode;
  onReject: 'close' | 'keep_open';
  status: ApprovalStatus;
  requestedById: string | null;
  requestedByName: string | null;
  decisions: ApprovalDecision[];
  createdAt: string;
  decidedAt: string | null;
}

/** Statuses a ticket cannot move to while an approval is waiting. */
export const GATED_STATUSES = ['in_progress', 'resolved'] as const;

export interface ApprovalSubject {
  type: string;
  priority: string;
  tags: string[];
  subject: string;
  description: string;
  templateId: string | null;
  /** Form answers by key. */
  answers: Record<string, unknown>;
}

const lower = (value: string) => value.trim().toLowerCase();

function fieldMatches(condition: NonNullable<ApprovalConditions['field']>, answer: unknown): boolean {
  if (answer === undefined || answer === null || answer === '') return false;
  const text = Array.isArray(answer) ? answer.join(', ') : String(answer);
  if (condition.op === 'contains') return lower(text).includes(lower(condition.value));
  if (condition.op === 'eq') {
    const a = Number(text);
    const b = Number(condition.value);
    return Number.isFinite(a) && Number.isFinite(b) && condition.value.trim() !== '' ? a === b : lower(text) === lower(condition.value);
  }
  // Amounts are often typed with separators or a currency: "R 75,000.00".
  const value = Number(text.replace(/[^\d.-]/g, ''));
  const limit = Number(condition.value.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(value) || !Number.isFinite(limit) || !/\d/.test(text)) return false;
  switch (condition.op) {
    case 'gt':
      return value > limit;
    case 'gte':
      return value >= limit;
    case 'lt':
      return value < limit;
    case 'lte':
      return value <= limit;
  }
  return false;
}

export function ruleMatches(conditions: ApprovalConditions, ticket: ApprovalSubject): boolean {
  if (conditions.types?.length && !conditions.types.includes(ticket.type)) return false;
  if (conditions.priorities?.length && !conditions.priorities.includes(ticket.priority)) return false;
  if (conditions.tags?.length) {
    const tags = new Set(ticket.tags.map(lower));
    if (!conditions.tags.some((tag) => tags.has(lower(tag)))) return false;
  }
  if (conditions.keywords?.length) {
    const haystack = lower(`${ticket.subject} ${ticket.description.replace(/<[^>]*>/g, ' ')}`);
    if (!conditions.keywords.some((word) => word.trim() && haystack.includes(lower(word)))) return false;
  }
  if (conditions.templateIds?.length && !(ticket.templateId && conditions.templateIds.includes(ticket.templateId))) return false;
  if (conditions.field?.key && !fieldMatches(conditions.field, ticket.answers[conditions.field.key])) return false;
  return true;
}

/** Where a request stands once a decision is added. */
export function outcome(mode: ApprovalMode, approverIds: string[], decisions: ApprovalDecision[]): ApprovalStatus {
  if (decisions.some((decision) => decision.decision === 'rejected')) return 'rejected';
  const approved = new Set(decisions.filter((decision) => decision.decision === 'approved').map((decision) => decision.userId));
  if (mode === 'any') return approved.size > 0 ? 'approved' : 'pending';
  return approverIds.every((id) => approved.has(id)) ? 'approved' : 'pending';
}
