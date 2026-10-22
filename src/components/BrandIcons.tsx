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

export function DiscordIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Discord" {...props}>
      <path
        d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
        fill="#5865F2"
      />
    </svg>
  );
}

/** The four-square mark Microsoft asks sign-in buttons to use. */
export function MicrosoftIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 21 21" className={className} role="img" aria-label="Microsoft" {...props}>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
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
  discord: DiscordIcon,
};

export function ProviderIcon({ provider, className }: { provider: IntegrationProvider; className?: string }) {
  const Icon = PROVIDER_ICONS[provider];
  return <Icon className={className} />;
}
