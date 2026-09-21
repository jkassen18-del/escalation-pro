import { cn, initials } from '@/lib/utils';

export function Avatar({
  name,
  color,
  size = 'md',
  className,
}: {
  name: string;
  color?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizes = {
    xs: 'size-4 text-[8px]',
    sm: 'size-5 text-[9px]',
    md: 'size-6 text-[10px]',
    lg: 'size-9 text-xs',
  };

  return (
    <span
      title={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
        sizes[size],
        className,
      )}
      style={{ background: color || 'var(--fg-subtle)' }}
    >
      {initials(name)}
    </span>
  );
}

/** Compact "avatar + name" pairing used in tables and property panels. */
export function UserChip({
  name,
  color,
  className,
  muted,
}: {
  name: string | null | undefined;
  color?: string | null;
  className?: string;
  muted?: boolean;
}) {
  if (!name) {
    return <span className={cn('text-xs text-subtle italic', className)}>Unassigned</span>;
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <Avatar name={name} color={color} size="xs" />
      <span className={cn('truncate text-xs', muted ? 'text-muted' : 'text-[var(--fg)]')}>{name}</span>
    </span>
  );
}
