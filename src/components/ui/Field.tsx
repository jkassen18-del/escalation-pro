import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const CONTROL =
  'w-full rounded-sm border bg-[var(--surface)] px-2.5 text-sm text-[var(--fg)] ' +
  'border-[var(--border-strong)] placeholder:text-[var(--fg-subtle)] ' +
  'transition-colors focus:border-[var(--focus)] focus:outline-none focus:ring-1 focus:ring-[var(--focus)] ' +
  'disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-[var(--surface-3)]';

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Field({ label, hint, error, required, children, htmlFor, className }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-[var(--fg)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--priority-urgent)]">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-[var(--priority-urgent)]">{error}</p>
      ) : hint ? (
        <p className="text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(CONTROL, 'h-8', invalid && 'border-[var(--priority-urgent)]', className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...props }, ref) {
    return <textarea ref={ref} rows={rows} className={cn(CONTROL, 'py-2 leading-relaxed resize-y', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          CONTROL,
          'h-8 appearance-none bg-no-repeat pr-7 cursor-pointer',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237d776e' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
          'bg-[position:right_0.5rem_center]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  hint?: string;
}

export function Checkbox({ label, hint, className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn('flex gap-2.5', className)}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer rounded-[2px] border-[var(--border-strong)] accent-[var(--accent)]"
        {...props}
      />
      {(label || hint) && (
        <div className="min-w-0 leading-tight">
          {label && (
            <label htmlFor={inputId} className="block cursor-pointer text-xs font-medium">
              {label}
            </label>
          )}
          {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
        </div>
      )}
    </div>
  );
}

/** Radio-style segmented control, used for short mutually exclusive choices. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-sm border border-[var(--border-strong)] p-0.5 surface-2', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[3px] px-2.5 py-1 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-[var(--surface)] text-[var(--fg)] shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
              : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
