import {
  AlertTriangle,
  Bug,
  Building2,
  Cloud,
  CreditCard,
  Database,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  Mail,
  Monitor,
  Phone,
  Printer,
  Server,
  Shield,
  Ticket,
  UserPlus,
  Wifi,
  Wrench,
} from 'lucide-react';
import type { TemplateIcon as TemplateIconName } from '@shared/templates';

const ICONS: Record<TemplateIconName, React.ComponentType<{ className?: string }>> = {
  ticket: Ticket,
  globe: Globe,
  wifi: Wifi,
  server: Server,
  laptop: Laptop,
  monitor: Monitor,
  key: KeyRound,
  lock: Lock,
  mail: Mail,
  printer: Printer,
  phone: Phone,
  database: Database,
  cloud: Cloud,
  shield: Shield,
  'user-plus': UserPlus,
  wrench: Wrench,
  building: Building2,
  'credit-card': CreditCard,
  'alert-triangle': AlertTriangle,
  bug: Bug,
};

export function TemplateIcon({ name, className }: { name: TemplateIconName; className?: string }) {
  const Icon = ICONS[name] ?? Ticket;
  return <Icon className={className} />;
}

/** The icon in its coloured tile, as used on the launcher. */
export function TemplateBadge({ name, color, size = 'md' }: { name: TemplateIconName; color: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={size === 'sm' ? 'flex size-6 shrink-0 items-center justify-center rounded-sm' : 'flex size-8 shrink-0 items-center justify-center rounded-md'}
      style={{ background: `${color}1f`, color }}
      aria-hidden
    >
      <TemplateIcon name={name} className={size === 'sm' ? 'size-3.5' : 'size-4'} />
    </span>
  );
}
