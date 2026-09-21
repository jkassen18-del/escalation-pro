import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { RichTextFormat } from '@shared/types';

/**
 * Renders a stored ticket body.
 *
 * Plain-text values - everything written before rich text existed, and
 * anything typed without formatting - keep their line breaks and are never
 * interpreted as markup. HTML values were sanitised on the way in by the
 * server, which is the only place that decision can be trusted.
 */
export function RichText({
  value,
  format,
  className,
  empty,
}: {
  value: string;
  format: RichTextFormat;
  className?: string;
  empty?: React.ReactNode;
}) {
  const isEmpty = useMemo(() => {
    if (format === 'text') return value.trim().length === 0;
    return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length === 0 && !/<img\b/i.test(value);
  }, [value, format]);

  if (isEmpty && empty) return <>{empty}</>;

  if (format === 'text') {
    return <div className={cn('text-sm leading-relaxed whitespace-pre-wrap', className)}>{value}</div>;
  }

  return (
    <div
      className={cn('rich-text text-sm leading-relaxed', className)}
      // Safe because the server sanitises every HTML body before storing it,
      // with an allow-list of tags, attributes, styles and URL schemes.
      dangerouslySetInnerHTML={{ __html: value }}
    />
  );
}
