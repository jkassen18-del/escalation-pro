import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { templatesApi } from '@/lib/templates-api';
import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { TemplateIcon } from '@/components/quick/TemplateIcon';
import type { TicketTemplate } from '@shared/templates';

/** "Quick ticket" in the header: every template this person can use, one click away. */
export function QuickTicketMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const [templates, setTemplates] = useState<TicketTemplate[]>([]);

  // Refreshed on navigation, so a template just created on the management page shows up.
  useEffect(() => {
    void templatesApi
      .usable()
      .then((result) => setTemplates(result.templates))
      .catch(() => setTemplates([]));
  }, [location.pathname]);

  if (templates.length === 0) return null;

  return (
    <Menu
      trigger={({ toggle }) => (
        <Button variant="secondary" size="sm" onClick={toggle} aria-haspopup="menu">
          <Zap className="size-3.5" />
          <span className="hidden sm:inline">Quick ticket</span>
        </Button>
      )}
      items={templates.map((template) => ({
        label: template.name,
        icon: ({ className }: { className?: string }) => <TemplateIcon name={template.icon} className={className} />,
        onSelect: () => navigate(`/tickets/quick/${template.id}`),
      }))}
    />
  );
}
