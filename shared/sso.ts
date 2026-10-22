/**
 * Single sign-on and team links, shared by the API and the client.
 */
import type { UserRole } from './types.ts';

export const SSO_PROVIDERS = ['entra', 'generic'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/** Entra ID's default claim names. */
export const ENTRA_CLAIMS = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.microsoft.com/identity/claims/displayname',
  givenName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  surname: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
} as const;

export interface SsoGroupRole {
  /** Entra group object id (or any group value the IdP sends). */
  group: string;
  role: UserRole;
}

export interface SamlSettings {
  enabled: boolean;
  provider: SsoProvider;
  /** Text on the sign-in button. */
  buttonLabel: string;
  /** The IdP's entity id ("Microsoft Entra Identifier"). */
  idpEntityId: string;
  /** Where the browser is sent to sign in ("Login URL"). */
  idpLoginUrl: string;
  /** PEM or bare base64 X.509 signing certificate(s), one per block. */
  idpCertificate: string;
  emailAttribute: string;
  nameAttribute: string;
  groupsAttribute: string;
  /** Create an account on first sign-in. Off: only existing people may sign in. */
  jitEnabled: boolean;
  jitRole: UserRole;
  jitTeamId: string | null;
  groupRoles: SsoGroupRole[];
  /** Password sign-in is refused for everyone except administrators. */
  requireSso: boolean;
}

/** What the service provider (this app) tells the IdP. Derived from the App URL. */
export interface SamlServiceProvider {
  entityId: string;
  acsUrl: string;
  signOnUrl: string;
  metadataUrl: string;
  /** False when the App URL is not set, so these are guesses from the browser's address. */
  fromAppUrl: boolean;
}

export const TEAM_LINK_ICONS = ['aws', 'azure', 'entra', 'generic'] as const;
export type TeamLinkIcon = (typeof TEAM_LINK_ICONS)[number];

export interface TeamLink {
  id: string;
  teamId: string;
  teamName: string | null;
  name: string;
  url: string;
  icon: TeamLinkIcon;
  description: string | null;
  position: number;
}

export const TEAM_LINK_PRESETS: Array<{ label: string; name: string; url: string; icon: TeamLinkIcon; description: string }> = [
  {
    label: 'AWS access portal',
    name: 'AWS access portal',
    url: 'https://<your-directory>.awsapps.com/start',
    icon: 'aws',
    description: 'IAM Identity Center: every AWS account and role you can use.',
  },
  { label: 'Azure portal', name: 'Azure portal', url: 'https://portal.azure.com/#@<tenant>', icon: 'azure', description: 'Subscriptions and resources.' },
  { label: 'Entra admin centre', name: 'Entra admin centre', url: 'https://entra.microsoft.com/', icon: 'entra', description: 'Users, groups and app registrations.' },
  { label: 'My Apps', name: 'My Apps', url: 'https://myapps.microsoft.com/', icon: 'entra', description: 'Every app Entra ID signs you in to.' },
];
