/**
 * Brand marks for the services this app integrates with.
 *
 * Inline SVG rather than an icon font or remote images: these render at any
 * size, need no network request, and keep their own brand colours in both
 * themes. Each is drawn on its own viewBox and scaled by the wrapping class.
 *
 * The marks identify the services being connected to, which is what the
 * providers' brand guidelines allow them to be used for. They are deliberately
 * not restyled - recolouring a logo to match the UI is exactly what those
 * guidelines prohibit.
 */
import type { ReactElement, SVGProps } from 'react';
import { Mail } from 'lucide-react';
import type { IntegrationProvider } from '@shared/types';

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function SlackIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 122.8 122.8" className={className} role="img" aria-label="Slack" {...props}>
      <path
        d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z"
        fill="#E01E5A"
      />
      <path
        d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zm0 6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z"
        fill="#36C5F0"
      />
      <path
        d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zm-6.5 0a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z"
        fill="#2EB67D"
      />
      <path
        d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z"
        fill="#ECB22E"
      />
    </svg>
  );
}

export function TeamsIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Microsoft Teams" {...props}>
      <circle cx="24.3" cy="7.6" r="3.4" fill="#5059C9" />
      <path
        d="M28.4 12.4h-7.1a1.2 1.2 0 0 0-1.2 1.2v7a5.6 5.6 0 0 0 5 5.6 5.6 5.6 0 0 0 4.9-5.6v-6.6a1.6 1.6 0 0 0-1.6-1.6z"
        fill="#5059C9"
      />
      <circle cx="14.6" cy="6.6" r="4.6" fill="#7B83EB" />
      <path
        d="M20.3 12.4H8.2a1.7 1.7 0 0 0-1.7 1.7v7.5a8 8 0 0 0 7.5 8.1 8 8 0 0 0 7.9-8.1v-7.5a1.7 1.7 0 0 0-1.6-1.7z"
        fill="#7B83EB"
      />
      <rect x="0.8" y="7" width="14.4" height="18" rx="1.7" fill="#4B53BC" />
      <path d="M12 11.1H4v2.1h2.9v8.1h2.3v-8.1H12z" fill="#fff" />
    </svg>
  );
}

export function LinearIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Linear" {...props}>
      <path
        d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.01c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.245-.575.536-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.171-1.443.266-2.197.303L.019 11.361a12.1 12.1 0 0 1 .303-2.198ZM.002 12.5l11.498 11.498C5.15 23.746.254 18.85.002 12.5Z"
        fill="#5E6AD2"
      />
    </svg>
  );
}

/** SMTP has no brand of its own, so it keeps the interface's own icon set. */
export function EmailIcon({ className }: { className?: string }) {
  return <Mail className={className} aria-label="Email" />;
}

const PROVIDER_ICONS: Record<IntegrationProvider, (props: IconProps) => ReactElement> = {
  slack: SlackIcon,
  msteams: TeamsIcon,
  linear: LinearIcon,
  email: EmailIcon,
};

export function ProviderIcon({ provider, className }: { provider: IntegrationProvider; className?: string }) {
  const Icon = PROVIDER_ICONS[provider];
  return <Icon className={className} />;
}
