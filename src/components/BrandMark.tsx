import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useBranding } from '@/state/branding';

/**
 * The company's logo, falling back to a monogram of its name.
 *
 * The monogram is derived from the organisation name rather than hardcoded, so
 * an unbranded deployment still looks deliberate instead of showing another
 * company's initials.
 */
function monogramOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'EP';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function BrandMark({ className, imageClassName }: { className?: string; imageClassName?: string }) {
  const { organizationName, logoUrl } = useBranding();
  // A logo that 404s (deleted in another tab, say) falls back rather than
  // leaving a broken-image icon in the chrome of every page.
  const [failed, setFailed] = useState(false);

  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt={organizationName}
        onError={() => setFailed(true)}
        className={cn('shrink-0 rounded-[4px] object-contain', imageClassName ?? className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[4px] bg-[var(--fg)] font-bold text-[var(--bg)]',
        className,
      )}
    >
      {monogramOf(organizationName)}
    </span>
  );
}
