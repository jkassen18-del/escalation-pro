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
import { Activity, Mail, Radar, Webhook } from 'lucide-react';
import type { AlertSourceKind, IntegrationProvider } from '@shared/types';

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

/* ---------------------------- InfraGrid sources --------------------------- */

export function DigitalOceanIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="DigitalOcean" {...props}>
      <path
        d="M16 29.4v-6.2c6.5 0 11.6-6.5 9.1-13.4a9.3 9.3 0 0 0-5.6-5.6C12.7 1.8 6.2 6.8 6.2 13.3H0C0 3 9.9-5 20.6 2.3c4.7 3.2 7.1 8.6 6.3 14.2-.9 6.6-6.3 12.9-10.9 12.9z"
        fill="#0080FF"
      />
      <path d="M16 23.2h-6.2V17H16v6.2z" fill="#0080FF" />
      <path d="M9.8 28h-4.8v-4.8h4.8V28z" fill="#0080FF" />
      <path d="M5 23.2H1v-4h4v4z" fill="#0080FF" />
    </svg>
  );
}

export function JenkinsIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Jenkins" {...props}>
      <path d="M8.7 25.6 6.4 30h19.2l-2.1-6.4-7.7-2.2-7.1 4.2z" fill="#335061" />
      <circle cx="16" cy="12" r="8.4" fill="#F0D6B7" />
      <path d="M16 2.2a9.8 9.8 0 0 0-9 6c1.5-1.4 4-2.6 6.2-2.9 3.2-.4 7 .6 9 2.4a9.8 9.8 0 0 0-6.2-5.5z" fill="#D33833" />
      <path d="M9.6 17.8c-1.5-1-2.6-2.8-2.6-4.9 0-1.2.3-2.3.9-3.2-.7 2.6.2 5.7 1.7 8.1z" fill="#EF3D3A" />
      <ellipse cx="12.4" cy="12.2" rx="1.1" ry="1.4" fill="#1D1919" />
      <ellipse cx="19.4" cy="12.2" rx="1.1" ry="1.4" fill="#1D1919" />
      <path d="M12.2 21.4h7.4v3.5l-3.8 1.4-3.6-1.5v-3.4z" fill="#F0D6B7" />
    </svg>
  );
}

export function AzureIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Microsoft Azure" {...props}>
      <defs>
        <linearGradient id="ig-az" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#114A8B" />
          <stop offset="1" stopColor="#0669BC" />
        </linearGradient>
      </defs>
      <path d="M10.7 3h8.2L10.4 28a1.3 1.3 0 0 1-1.2.9H2.8a1.3 1.3 0 0 1-1.2-1.7L9.5 3.9A1.3 1.3 0 0 1 10.7 3z" fill="url(#ig-az)" />
      <path d="M22.6 20H9.7a.6.6 0 0 0-.4 1l8.3 7.7c.2.2.6.3.9.3h7.4L22.6 20z" fill="#0078D4" />
      <path d="M10.7 3h.1L2.4 27.4A1.3 1.3 0 0 0 3.6 29h6.5c.6 0 1.1-.4 1.2-.9l1.7-5 6.1 5.7c.2.2.5.2.8.2h7.4l-3.2-9.2h-9.5L22.7 3H10.7z" fill="#0078D4" opacity=".6" />
      <path d="M22.5 3.9a1.3 1.3 0 0 0-1.2-.9h-10.5a1.3 1.3 0 0 1 1.2.9l7.9 23.3a1.3 1.3 0 0 1-1.2 1.7h10.5a1.3 1.3 0 0 0 1.2-1.7L22.5 3.9z" fill="#50E6FF" opacity=".9" />
    </svg>
  );
}

export function AwsIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Amazon Web Services" {...props}>
      <path
        d="M9.3 13.6c0 .4 0 .7.1.9l.5 1v.3l-.6.4h-.3l-.3-.3-.4-.5-.3-.5c-.7.9-1.7 1.3-2.8 1.3-.8 0-1.4-.2-1.9-.7-.5-.5-.7-1.1-.7-1.8 0-.8.3-1.5.9-2 .6-.5 1.4-.7 2.4-.7.4 0 .7 0 1.1.1l1.2.2v-.7c0-.7-.2-1.2-.5-1.5-.3-.3-.8-.4-1.6-.4l-1.1.1-1.1.4h-.4c-.2 0-.2-.1-.2-.4v-.5l.1-.3.4-.2c.4-.2.9-.4 1.4-.5l1.6-.2c1.2 0 2.1.3 2.7.8.6.6.9 1.4.9 2.5v3.2zm-3.9 1.5.9-.2 1-.6.4-.7.1-.9v-.4a8 8 0 0 0-1.9-.2c-.7 0-1.2.1-1.5.4-.3.3-.5.6-.5 1.1s.1.8.4 1c.2.3.6.4 1.1.4zm7.7 1.1-.5-.1-.2-.4-2.3-7.5-.1-.4c0-.2 0-.3.2-.3h.9l.4.1.2.4 1.6 6.4L15 8l.2-.4.4-.1h.7l.4.1.2.4 1.6 6.5L20.2 8l.2-.4.4-.1h.8c.2 0 .3.1.3.3v.2l-.1.3-2.4 7.4-.2.4-.4.1h-.7l-.4-.1-.2-.4-1.6-6.3-1.6 6.3-.2.4-.4.1h-.7zm12.4.2-1.6-.2-1.2-.4-.3-.3-.1-.3v-.5c0-.2.1-.3.2-.3h.2l.3.1 1 .3 1.1.1c.6 0 1-.1 1.3-.3.3-.2.5-.5.5-.9l-.2-.6-.9-.5-1.3-.4c-.7-.2-1.2-.5-1.5-.9a2 2 0 0 1-.5-1.4c0-.4.1-.8.3-1.1l.6-.7.9-.4 1.1-.2h.7l.7.2.5.1.4.2.2.2.1.4v.4c0 .3-.1.4-.2.4l-.4-.1c-.5-.2-1-.3-1.6-.3s-.9.1-1.2.3c-.3.2-.4.4-.4.8l.2.6c.2.2.5.3 1 .5l1.3.4c.7.2 1.1.5 1.4.9.3.4.4.8.4 1.3s-.1.9-.3 1.2l-.7.8-1 .5-1.3.1z"
        fill="#252F3E"
      />
      <path
        d="M27.5 21.9c-3.1 2.3-7.7 3.5-11.6 3.5-5.5 0-10.4-2-14.1-5.4-.3-.3 0-.6.3-.4 4 2.3 8.9 3.7 14 3.7 3.5 0 7.3-.7 10.8-2.2.5-.2 1 .4.6.8zm1.3-1.5c-.4-.5-2.7-.2-3.7-.1-.3 0-.4-.2-.1-.4 1.8-1.3 4.8-.9 5.2-.5.3.5-.1 3.5-1.8 4.9-.3.2-.5.1-.4-.2.4-1 1.2-3.2.8-3.7z"
        fill="#FF9900"
      />
    </svg>
  );
}

export function CrowdStrikeIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="CrowdStrike" {...props}>
      <path
        d="M16 1.5 3.5 6.2v8.4c0 7.2 5.1 13.9 12.5 15.9 7.4-2 12.5-8.7 12.5-15.9V6.2L16 1.5z"
        fill="#FC0000"
      />
      <path
        d="M16 5.4 7.2 8.7v6c0 5.2 3.6 10 8.8 11.6 5.2-1.6 8.8-6.4 8.8-11.6v-6L16 5.4z"
        fill="#fff"
        opacity=".15"
      />
      <path
        d="M11 11.8c1.4.3 2.3 1 3.1 2 .5.7.7 1.4.8 2.2 0 .3.2.4.4.5l1.6.6c.6.3 1.1.7 1.4 1.3.1.2.2.3.4.1.6-.5 1.4-.6 2.1-.4l1.5.5c-.9-.9-2-1.5-3.2-1.9-.3-.1-.4-.2-.4-.5 0-1-.4-1.9-1.1-2.6-.9-1-2.1-1.5-3.4-1.7l-3.2-.1z"
        fill="#fff"
      />
      <path
        d="M8.3 15c1.6 0 3 .5 4.2 1.5.7.6 1.1 1.3 1.3 2.2 0 .3.2.4.5.5l1.8.5c.7.2 1.2.7 1.6 1.3.1.2.2.2.4 0 .6-.4 1.3-.5 2-.3l1.3.4-2.5-2-2-.8c-.3-.1-.4-.3-.4-.6a3.8 3.8 0 0 0-1.4-2.5c-1.6-1.3-3.4-1.9-5.4-2l-1.4-.2z"
        fill="#fff"
        opacity=".75"
      />
    </svg>
  );
}

export function AnsibleIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Ansible" {...props}>
      <circle cx="16" cy="16" r="15" fill="#EE0000" />
      <path
        d="M15.2 8.6 9 23.4h2.6l1.5-3.8h5.6l-2.2-2h-2.6l2.1-5.3 4.9 11.1h2.6L16.6 8.6a.8.8 0 0 0-1.4 0z"
        fill="#fff"
      />
    </svg>
  );
}

export function LinuxIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Linux" {...props}>
      <path
        d="M16 1.8c-3.2 0-4.6 2.5-4.6 5.4 0 1.5.2 2.6-.3 4-.6 1.5-1.8 3-2.9 4.9-1.1 1.8-2 3.6-2 5.5 0 .7.2 1.3.6 1.7-.4.9-.2 1.8.5 2.3.7.5 1.8.6 3 .9 1.3.3 2 .8 2.8 1.3.8.5 1.7.9 3 .9 1.2 0 2.2-.5 3-1 .8-.6 1.6-1 2.9-1.3 1.2-.2 2.3-.4 3-1 .6-.5.8-1.4.4-2.3.4-.4.6-1 .6-1.6 0-1.9-1-3.7-2.1-5.5-1.1-1.9-2.3-3.4-2.9-4.9-.5-1.4-.3-2.5-.3-4 0-2.9-1.4-5.4-4.7-5.4z"
        fill="#111"
      />
      <ellipse cx="13.2" cy="8.4" rx="1.5" ry="2" fill="#fff" />
      <ellipse cx="18.8" cy="8.4" rx="1.5" ry="2" fill="#fff" />
      <ellipse cx="13.4" cy="8.8" rx=".7" ry="1" fill="#111" />
      <ellipse cx="18.6" cy="8.8" rx=".7" ry="1" fill="#111" />
      <path d="M16 11.2c1.9 0 3.4 1 3.4 1.8 0 .8-1.5 1.5-3.4 1.5s-3.4-.7-3.4-1.5c0-.8 1.5-1.8 3.4-1.8z" fill="#F5BD0C" />
      <path d="M16 12c1 0 1.8.4 1.8.8s-.8.7-1.8.7-1.8-.3-1.8-.7.8-.8 1.8-.8z" fill="#E8A200" />
      <path
        d="M11.8 24.4c-.9-.5-1.7-.9-2.8-1.1-.7-.2-1.3-.3-1.6-.5.2-.8.9-1.6 1.6-2.4.8-.9 1.5-1.9 1.9-2.9.3.9.5 2 .8 3.1.3 1.2.7 2.3.1 3.8zm8.4 0c-.6-1.5-.2-2.6.1-3.8.3-1.1.5-2.2.8-3.1.4 1 1.1 2 1.9 2.9.7.8 1.4 1.6 1.6 2.4-.3.2-.9.3-1.6.5-1.1.2-1.9.6-2.8 1.1z"
        fill="#F5BD0C"
      />
    </svg>
  );
}

export function WindowsServerIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Windows Server" {...props}>
      <path d="M2 6.2 14.3 4.5v11.1H2V6.2z" fill="#00ADEF" />
      <path d="M15.7 4.3 30 2.2v13.4H15.7V4.3z" fill="#00ADEF" />
      <path d="M2 16.9h12.3V28L2 26.3V16.9z" fill="#00ADEF" />
      <path d="M15.7 16.9H30v13.4l-14.3-2.1V16.9z" fill="#00ADEF" />
    </svg>
  );
}

export function HeartbeatIcon({ className }: { className?: string }) {
  return <Activity className={className} aria-label="Heartbeat" />;
}

export function ProbeIcon({ className }: { className?: string }) {
  return <Radar className={className} aria-label="API probe" />;
}

export function GenericSourceIcon({ className }: { className?: string }) {
  return <Webhook className={className} aria-label="Webhook" />;
}

const SOURCE_ICONS: Record<AlertSourceKind, (props: { className?: string }) => ReactElement> = {
  digitalocean: DigitalOceanIcon,
  jenkins: JenkinsIcon,
  azure: AzureIcon,
  aws: AwsIcon,
  crowdstrike: CrowdStrikeIcon,
  ansible: AnsibleIcon,
  linux: LinuxIcon,
  windows: WindowsServerIcon,
  heartbeat: HeartbeatIcon,
  probe: ProbeIcon,
  generic: GenericSourceIcon,
};

/** The mark for one InfraGrid source kind. */
export function SourceIcon({ kind, className }: { kind: AlertSourceKind; className?: string }) {
  const Icon = SOURCE_ICONS[kind] ?? GenericSourceIcon;
  return <Icon className={className} />;
}

export const SOURCE_LABELS: Record<AlertSourceKind, string> = {
  digitalocean: 'DigitalOcean',
  jenkins: 'Jenkins',
  azure: 'Microsoft Azure',
  aws: 'Amazon Web Services',
  crowdstrike: 'CrowdStrike',
  ansible: 'Ansible / AWX',
  linux: 'Linux servers',
  windows: 'Windows servers',
  heartbeat: 'Heartbeats',
  probe: 'API health checks',
  generic: 'Generic webhook',
};
