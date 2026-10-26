import type { AlertSourceKind } from '@shared/ops';

/**
 * Every integration on the catalogue page. The `id` is also the key of its
 * status from /api/integrations/catalogue and the value of `?setup=` that
 * opens its setup straight from a link (the Command centre checklist uses it).
 */
export type TileKind = 'chat' | 'source' | 'custom_http' | 'heartbeats' | 'databases' | 'lookups' | 'sso';

export interface CatalogueTile {
  id: string;
  name: string;
  blurb: string;
  group: 'chat' | 'monitoring' | 'developer' | 'signin';
  kind: TileKind;
  /** For monitoring tiles: the alert source kind it creates. */
  sourceKind?: AlertSourceKind;
  /** Extra words the search box should match. */
  keywords?: string;
}

export const GROUPS: Array<{ id: CatalogueTile['group']; label: string; hint: string }> = [
  { id: 'chat', label: 'Chat & collaboration', hint: 'Where tickets are announced, discussed and raised.' },
  { id: 'monitoring', label: 'Monitoring & cloud', hint: 'Alerts that open incidents and page whoever is on call.' },
  { id: 'developer', label: 'Developer', hint: 'Your own systems, jobs and databases.' },
  { id: 'signin', label: 'Sign-in', hint: 'How people sign in.' },
];

export const TILES: CatalogueTile[] = [
  { id: 'slack', name: 'Slack', group: 'chat', kind: 'chat', blurb: 'Announce tickets in channels, reply in threads, raise tickets with a slash command.', keywords: 'chat channel bot' },
  { id: 'msteams', name: 'Microsoft Teams', group: 'chat', kind: 'chat', blurb: 'InfraBot posts cards, takes replies and raises tickets; can ring on-call people.', keywords: 'chat bot microsoft calls' },
  { id: 'discord', name: 'Discord', group: 'chat', kind: 'chat', blurb: 'Raise tickets from Discord and follow them in a channel.', keywords: 'chat bot server' },
  { id: 'linear', name: 'Linear', group: 'chat', kind: 'chat', blurb: 'Mirror tickets as Linear issues, each department into its own Linear team.', keywords: 'issues engineering' },
  { id: 'github', name: 'GitHub', group: 'chat', kind: 'chat', blurb: 'Turn tickets into GitHub issues per department; closing the issue resolves the ticket, and PRs that mention it are linked.', keywords: 'issues git pull request code' },
  { id: 'email', name: 'Email (SMTP)', group: 'chat', kind: 'chat', blurb: 'Email assignees, requesters and watchers when a ticket changes.', keywords: 'smtp mail outlook exchange' },

  { id: 'source:aws_sns', name: 'AWS CloudWatch', group: 'monitoring', kind: 'source', sourceKind: 'aws_sns', blurb: 'CloudWatch alarms and AWS Health events via SNS.', keywords: 'amazon sns eventbridge' },
  { id: 'source:azure_monitor', name: 'Azure Monitor', group: 'monitoring', kind: 'source', sourceKind: 'azure_monitor', blurb: 'Action group webhooks with the common alert schema.', keywords: 'microsoft' },
  { id: 'source:grafana', name: 'Grafana / Alertmanager', group: 'monitoring', kind: 'source', sourceKind: 'grafana', blurb: 'Contact points and Prometheus Alertmanager receivers.', keywords: 'prometheus' },
  { id: 'source:jenkins', name: 'Jenkins', group: 'monitoring', kind: 'source', sourceKind: 'jenkins', blurb: 'Failed builds open an incident; the next green build resolves it.', keywords: 'ci build' },
  { id: 'source:github', name: 'GitHub Actions & alerts', group: 'monitoring', kind: 'source', sourceKind: 'github', blurb: 'A failed workflow on the main branch opens an incident; the next green run resolves it. Also deployments and security alerts.', keywords: 'ci actions workflow dependabot deploy' },
  { id: 'source:cloudflare', name: 'Cloudflare', group: 'monitoring', kind: 'source', sourceKind: 'cloudflare', blurb: 'Notifications for origins, tunnels, health checks and DDoS.', keywords: 'dns tunnel' },
  { id: 'source:digitalocean', name: 'DigitalOcean', group: 'monitoring', kind: 'source', sourceKind: 'digitalocean', blurb: 'Monitoring alert policies forwarded as JSON.', keywords: 'droplet' },
  { id: 'source:entra_id', name: 'Entra ID / Microsoft 365', group: 'monitoring', kind: 'source', sourceKind: 'entra_id', blurb: 'Service health and sign-in alerts forwarded by a Logic App or flow.', keywords: 'azure ad microsoft' },
  { id: 'source:stratigix', name: 'Stratigix', group: 'monitoring', kind: 'source', sourceKind: 'stratigix', blurb: 'Stratigix alerts as JSON, mapped to severity and status.' },
  { id: 'source:generic', name: 'Generic webhook', group: 'monitoring', kind: 'source', sourceKind: 'generic', blurb: 'Anything that can POST JSON: scripts, other tools, your own apps.', keywords: 'json http' },

  { id: 'custom_http', name: 'Custom HTTP', group: 'developer', kind: 'custom_http', blurb: 'Send ticket events to any URL, with your own headers, body and signature.', keywords: 'webhook outbound api' },
  { id: 'heartbeats', name: 'Heartbeats', group: 'developer', kind: 'heartbeats', blurb: 'Cron jobs and scripts ping a URL; silence pages someone.', keywords: 'cron job dead man' },
  { id: 'databases', name: 'Database connectors', group: 'developer', kind: 'databases', blurb: 'Health checks and encrypted backups for Postgres, MySQL, MongoDB, SQLite, SQL Server.', keywords: 'backup postgres mysql' },
  { id: 'lookups', name: 'Database lookups', group: 'developer', kind: 'lookups', blurb: 'Offer records from your own database as options on intake forms.', keywords: 'form customer' },

  { id: 'sso', name: 'Microsoft sign-in (SSO)', group: 'signin', kind: 'sso', blurb: 'Single sign-on with Microsoft Entra ID or any SAML provider.', keywords: 'saml entra azure login' },
];

/** Step-by-step instructions for each monitoring provider, shown beside its webhook URL. */
export const SOURCE_STEPS: Record<AlertSourceKind, string[]> = {
  aws_sns: [
    'In the AWS console, open Simple Notification Service → Topics and create a topic (Standard), e.g. "infraticket-alerts".',
    'Create subscription → Protocol: HTTPS → Endpoint: the webhook URL below. InfraTicket confirms it automatically.',
    'Point your CloudWatch alarms\' alarm and OK actions at the topic. For AWS Health, add an EventBridge rule (source aws.health) targeting the topic.',
  ],
  azure_monitor: [
    'In the Azure portal, open Monitor → Alerts → Action groups and create (or edit) an action group.',
    'Actions → Webhook → paste the URL below and set "Enable the common alert schema" to Yes.',
    'Attach the action group to your alert rules. Resolved alerts close the incident automatically.',
  ],
  grafana: [
    'Grafana: Alerting → Contact points → New → Integration: Webhook → URL below. Use it in a notification policy.',
    'Prometheus Alertmanager: add a receiver with webhook_configs: [{ url: <URL below>, send_resolved: true }].',
  ],
  jenkins: [
    'Install the Notification plugin (free) and add an endpoint: Format JSON, Protocol HTTP, Event "Job Finalized", URL below.',
    'Or add a post-build step: curl -X POST -H "Content-Type: application/json" -d \'{"name":"$JOB_NAME","build":{"status":"FAILURE","full_url":"$BUILD_URL"}}\' <URL>.',
  ],
  github: [
    'In the repository (or organisation): Settings → Webhooks → Add webhook. Paste the URL below as the Payload URL, content type application/json.',
    'Choose "Let me select individual events": Workflow runs, Deployment statuses, and any of Code scanning alerts, Dependabot alerts, Secret scanning alerts.',
    'Only runs on the default branch count, so a failing pull request never pages anyone. The next successful run of the same workflow resolves the incident.',
  ],
  cloudflare: [
    'In the Cloudflare dashboard: Notifications → Destinations → Webhooks → Create, paste the URL below and save.',
    'Notifications → Add: choose the events (origin errors, tunnel health, health checks, DDoS) and the webhook destination.',
  ],
  digitalocean: [
    'Create an alert policy under Monitoring for the droplets or databases to watch.',
    'DigitalOcean only notifies by email or Slack, so forward with a tiny script or a Slack-compatible relay that POSTs JSON to the URL below.',
  ],
  entra_id: [
    'Create a Logic App (consumption plan, free grant) or a Power Automate flow triggered by the alert or service-health event.',
    'Add an HTTP action: POST, the URL below, body with title, severity and status fields.',
  ],
  stratigix: ['Configure Stratigix to POST its alerts as JSON to the URL below.', 'Map title, severity and status with the JSON paths in the source settings if they are not detected automatically.'],
  generic: [
    'POST JSON to the URL below, e.g. {"title":"Disk full on db-1","severity":"critical","status":"firing","dedup_key":"db-1-disk"}.',
    'Send the same dedup_key with "status":"resolved" to close the incident.',
  ],
};
