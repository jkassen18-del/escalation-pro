import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--fg)] text-[var(--bg)] border border-transparent hover:opacity-88 active:opacity-80 disabled:opacity-40',
  secondary:
    'bg-[var(--surface)] text-[var(--fg)] border border-[var(--border-strong)] hover:bg-[var(--surface-3)] disabled:opacity-45',
  ghost:
    'bg-transparent text-[var(--fg-muted)] border border-transparent hover:bg-[var(--surface-3)] hover:text-[var(--fg)] disabled:opacity-45',
  danger:
    'bg-[var(--priority-urgent)] text-white border border-transparent hover:opacity-88 disabled:opacity-45',
  link: 'bg-transparent border-0 p-0 h-auto text-[var(--accent)] hover:underline underline-offset-2',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-1.5',
  lg: 'h-9 px-4 text-sm gap-2',
  icon: 'h-8 w-8 p-0 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-medium whitespace-nowrap',
        'transition-[background-color,opacity,border-color] duration-100',
        'disabled:cursor-not-allowed',
        variant !== 'link' && SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-3.5 animate-spin-slow" aria-hidden />}
      {children}
    </button>
  );
});
