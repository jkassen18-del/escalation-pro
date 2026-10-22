import { Cloud, Fingerprint, Link2, Server, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TeamLinkIcon as Kind } from '@shared/sso';

/**
 * A neutral glyph per kind of system rather than vendor logos: the links are
 * the team's own, and the icon only needs to tell them apart at a glance.
 */
const ICONS: Record<Kind, { icon: LucideIcon; label: string; tint: string }> = {
  aws: { icon: Server, label: 'AWS', tint: '#d97706' },
  azure: { icon: Cloud, label: 'Azure', tint: '#2563eb' },
  entra: { icon: Fingerprint, label: 'Entra ID', tint: '#0891b2' },
  generic: { icon: Link2, label: 'Link', tint: 'var(--fg-subtle)' },
};

export const TEAM_LINK_ICON_LABELS: Record<Kind, string> = {
  aws: ICONS.aws.label,
  azure: ICONS.azure.label,
  entra: ICONS.entra.label,
  generic: 'Other',
};

export function TeamLinkIcon({ kind, className }: { kind: Kind; className?: string }) {
  const { icon: Icon, tint } = ICONS[kind] ?? ICONS.generic;
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-sm border surface-2', className)}>
      <Icon className="size-3.5" style={{ color: tint }} />
    </span>
  );
}
