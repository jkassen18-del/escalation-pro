import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { AlertSourceKind } from '@shared/ops';
import aws from '@/assets/brands/aws.png';
import azure from '@/assets/brands/azure.png';
import cloudflare from '@/assets/brands/cloudflare.png';
import digitalocean from '@/assets/brands/digitalocean.png';
import entra from '@/assets/brands/entra.png';
import grafana from '@/assets/brands/grafana.svg';
import jenkins from '@/assets/brands/jenkins.svg';

/**
 * Full-colour logos for the monitoring services alerts arrive from. Bundled
 * files, not remote images, so they show offline and in the portable exe.
 */
const SOURCE_LOGOS: Partial<Record<AlertSourceKind, { src: string; label: string }>> = {
  aws_sns: { src: aws, label: 'AWS' },
  azure_monitor: { src: azure, label: 'Azure' },
  cloudflare: { src: cloudflare, label: 'Cloudflare' },
  digitalocean: { src: digitalocean, label: 'DigitalOcean' },
  entra_id: { src: entra, label: 'Microsoft Entra ID' },
  grafana: { src: grafana, label: 'Grafana' },
  jenkins: { src: jenkins, label: 'Jenkins' },
};

export function SourceKindLogo({ kind, className }: { kind: AlertSourceKind; className?: string }): ReactNode {
  const logo = SOURCE_LOGOS[kind];
  if (!logo) return null;
  return <img src={logo.src} alt={logo.label} draggable={false} className={cn('size-5 object-contain', className)} />;
}

export function hasSourceLogo(kind: AlertSourceKind): boolean {
  return Boolean(SOURCE_LOGOS[kind]);
}

/**
 * The square every integration mark sits on. Always light, in both themes,
 * because several logos (the AWS wordmark, Jenkins) are drawn for a light
 * background and must not be recoloured.
 */
export function LogoTile({ children, size = 'md', className }: { children: ReactNode; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border border-black/10 bg-white text-slate-500',
        size === 'md' ? 'size-10 p-1.5' : 'size-7 p-1',
        className,
      )}
    >
      {children}
    </span>
  );
}
