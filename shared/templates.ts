import type { TeamFormField, TicketPriority, TicketType } from './types.ts';

/**
 * Quick tickets: templated ticket types that go straight to one department.
 * Shared by the API and the client.
 */

/** The icons a template can show. Kept to a fixed set so the client can bundle them. */
export const TEMPLATE_ICONS = [
  'ticket',
  'globe',
  'wifi',
  'server',
  'laptop',
  'monitor',
  'key',
  'lock',
  'mail',
  'printer',
  'phone',
  'database',
  'cloud',
  'shield',
  'user-plus',
  'wrench',
  'building',
  'credit-card',
  'alert-triangle',
  'bug',
] as const;
export type TemplateIcon = (typeof TEMPLATE_ICONS)[number];

export const SCREENSHOT_MODES = ['off', 'encouraged', 'required'] as const;
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];

/** A template's own question. Same shape as a team form field, without a team. */
export type TemplateField = Omit<TeamFormField, 'teamId' | 'dataSourceId'>;

export interface TicketTemplate {
  id: string;
  name: string;
  description: string | null;
  icon: TemplateIcon;
  color: string;
  /** The department it routes to. Null only when that team has since been deleted. */
  teamId: string | null;
  teamName: string | null;
  ticketType: TicketType;
  priority: TicketPriority;
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4' | null;
  /** e.g. "Site issue: {{site}}". Placeholders are field keys, plus {{summary}}, {{name}} and {{requester}}. */
  subjectTemplate: string;
  guidance: string | null;
  fields: TemplateField[];
  screenshot: ScreenshotMode;
  tags: string[];
  /** Teams whose members may use it; empty means everyone who can raise tickets. */
  audienceTeamIds: string[];
  enabled: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}
