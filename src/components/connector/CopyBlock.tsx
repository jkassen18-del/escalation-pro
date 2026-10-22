import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Snippet } from '@/lib/connector-api';

/** A multi-line snippet with a copy button: commands and config files. */
export function CopyBlock({ code, className, label = 'Copy' }: { code: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn('relative rounded-sm border border-[var(--border-strong)] surface-2', className)}>
      <pre className="whitespace-pre-wrap py-2 pl-2.5 pr-20 [overflow-wrap:anywhere] font-mono text-2xs leading-relaxed">{code}</pre>
      <button
        type="button"
        className="absolute right-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-1.5 text-2xs text-[var(--fg-muted)] hover:text-[var(--fg)]"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard blocked on plain http; the text is selectable.
          }
        }}
      >
        {copied ? <Check className="size-3 text-[#16a34a]" /> : <Copy className="size-3" />}
        {copied ? 'Copied' : label}
      </button>
    </div>
  );
}

/** One tab per client, each with its own ready-to-paste setup. */
export function SnippetTabs({ snippets }: { snippets: Snippet[] }) {
  const [active, setActive] = useState(snippets[0]?.id);
  const current = snippets.find((s) => s.id === active) ?? snippets[0];
  if (!current) return null;
  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {snippets.map((snippet) => (
          <button
            key={snippet.id}
            role="tab"
            type="button"
            aria-selected={snippet.id === current.id}
            onClick={() => setActive(snippet.id)}
            className={cn(
              '-mb-px border-b-2 px-2 py-1.5 text-xs font-medium',
              snippet.id === current.id ? 'border-[var(--fg)] text-[var(--fg)]' : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {snippet.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{current.note}</p>
      <CopyBlock code={current.code} className="mt-2" />
    </div>
  );
}
