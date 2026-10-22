import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { templatesApi } from '@/lib/templates-api';
import { useAuth } from '@/state/auth';
import { TemplateBadge } from '@/components/quick/TemplateIcon';
import type { TicketTemplate } from '@shared/templates';

/**
 * The quick-ticket launcher: one tile per template this person can use.
 * Renders nothing when there are none, except a pointer for whoever can
 * create them.
 */
export function QuickTicketGrid() {
  const { can } = useAuth();
  const [templates, setTemplates] = useState<TicketTemplate[] | null>(null);

  useEffect(() => {
    void templatesApi
      .usable()
      .then((result) => setTemplates(result.templates))
      .catch(() => setTemplates([]));
  }, []);

  if (!templates) return null;
  if (templates.length === 0) {
    if (!can('templates.manage')) return null;
    return (
      <p className="mt-4 rounded-md border border-dashed px-3 py-2.5 text-xs text-subtle">
        <Zap className="mr-1 inline size-3.5" aria-hidden />
        Set up <Link to="/quick-tickets" className="text-[var(--accent)] hover:underline">quick tickets</Link> for common requests, so people can raise them in a few clicks and they go straight to the right department.
      </p>
    );
  }

  return (
    <section className="mt-5" aria-labelledby="quick-tickets-heading">
      <h2 id="quick-tickets-heading" className="eyebrow mb-2">Quick tickets</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((template) => (
          <Link
            key={template.id}
            to={`/tickets/quick/${template.id}`}
            className="flex items-start gap-2.5 rounded-md border p-3 surface transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
          >
            <TemplateBadge name={template.icon} color={template.color} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{template.name}</span>
              <span className="block truncate text-2xs text-subtle">
                {template.description || `Goes to ${template.teamName ?? 'a department'}`}
              </span>
            </span>
          </Link>
        ))}
      </div>
      <p className="mt-4 text-2xs text-subtle">Or fill in the full form below.</p>
    </section>
  );
}
