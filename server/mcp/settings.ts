import type { Request } from 'express';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';
import type { ConnectorSettings } from '../../shared/connector.ts';

/**
 * Org-wide settings for the Claude connector. Stored with the ops.* settings
 * so they never leak through GET /api/settings.
 */
const DEFAULTS: ConnectorSettings = { enabled: true, mode: 'read_write', publicUrl: '' };

export async function loadConnectorSettings(): Promise<ConnectorSettings> {
  return getOpsSetting<ConnectorSettings>('claude_connector', DEFAULTS);
}

export async function saveConnectorSettings(input: Partial<ConnectorSettings>): Promise<ConnectorSettings> {
  const current = await loadConnectorSettings();
  const publicUrl = typeof input.publicUrl === 'string' ? input.publicUrl.trim().replace(/\/+$/, '') : current.publicUrl;
  if (publicUrl && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(publicUrl)) {
    throw new Error('The connector address must be a URL such as https://tickets.example.com');
  }
  const next: ConnectorSettings = {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    mode: input.mode === 'read_only' || input.mode === 'read_write' ? input.mode : current.mode,
    publicUrl,
  };
  await setOpsSetting('claude_connector', next);
  return next;
}

/**
 * The address Claude is told to use, in order of preference: the connector's
 * own setting, the App URL, the environment, then whatever host the request
 * came in on (fine on a laptop, but set one of the others for anything real:
 * tokens are bound to this address, so it must not change).
 */
export async function connectorBaseUrl(req?: Request): Promise<string> {
  const connector = await loadConnectorSettings();
  if (connector.publicUrl) return connector.publicUrl;
  const settings = await getSettings();
  const configured = (settings.appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

/** The MCP endpoint's canonical URI: the `resource` every token is bound to (RFC 8707). */
export async function resourceUri(req?: Request): Promise<string> {
  return `${await connectorBaseUrl(req)}/mcp`;
}
