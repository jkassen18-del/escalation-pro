/**
 * The Claude connector: Claude reads and acts on InfraTicket through the
 * Model Context Protocol, as the person who connected it.
 */

/** `read` sees what the person can see; `read_write` can also change it. */
export type ConnectorScope = 'read' | 'read_write';

export interface ConnectorSettings {
  enabled: boolean;
  /** Org-wide cap: `read_only` turns every write tool off, whatever a token allows. */
  mode: 'read_write' | 'read_only';
  /** The address to advertise to Claude. Empty means the App URL. */
  publicUrl: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  userName?: string | null;
  name: string;
  /** e.g. "itk_Ab3f…", enough to recognise it, useless to anyone else. */
  prefix: string;
  scope: ConnectorScope;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** An app (e.g. claude.ai) someone approved through OAuth. */
export interface ConnectedApp {
  grantId: string;
  clientId: string;
  clientName: string;
  scope: ConnectorScope;
  lastUsedAt: string | null;
  createdAt: string;
}

/** What the consent screen shows about a pending authorization. */
export interface OAuthConsentRequest {
  id: string;
  clientName: string;
  clientId: string;
  /** Shown prominently: where the person will be sent back to. */
  redirectHost: string;
  scope: ConnectorScope;
  /** Capped by the org mode, so the screen never promises more than is granted. */
  effectiveScope: ConnectorScope;
  expiresAt: string;
}

export interface ConnectorInfo {
  settings: ConnectorSettings;
  mcpUrl: string;
  /** Whether claude.ai can reach it: an https address that isn't localhost. */
  publicHttps: boolean;
}

/** An OAuth client an admin registered by hand (e.g. for Copilot Studio). */
export interface ConfidentialClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}
