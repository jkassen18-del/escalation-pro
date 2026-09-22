import type { AlertSeverity, AlertSourceKind } from '../../shared/types.ts';

/**
 * Turning eight vendors' payloads into one shape.
 *
 * Every monitoring system has its own idea of what an alert looks like, what
 * it calls "bad", and how it says a thing has recovered. None of that should
 * reach the rest of the app, so each vendor gets an adapter here and
 * everything downstream sees a NormalisedAlert.
 *
 * Two things matter more than the field mapping:
 *
 *  - The **dedupe key** has to identify the *condition*, not the occurrence.
 *    Get it wrong and a flapping disk opens a ticket a minute.
 *  - The **resolved** signal has to be recognised, or nothing ever closes and
 *    the grid stays red forever.
 *
 * Unknown shapes are not dropped. A vendor that changes its payload, or a
 * field that is missing, still produces an alert with whatever could be read
 * - because an alert that reads badly is recoverable and a swallowed one is
 * not.
 */

export interface NormalisedAlert {
  dedupeKey: string;
  title: string;
  body?: string | null;
  severity: AlertSeverity;
  status: 'firing' | 'resolved';
  resource?: string | null;
  externalUrl?: string | null;
}

/** Some payloads carry several alerts; AWS and Azure batch them. */
export type ParseResult =
  | { kind: 'alerts'; alerts: NormalisedAlert[] }
  /** AWS SNS confirms a subscription before it will deliver anything. */
  | { kind: 'confirm'; url: string }
  | { kind: 'ignored'; reason: string };

type Payload = Record<string, any>;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** First of several possible paths that actually has a value. */
function pick(payload: Payload, ...paths: string[]): string | null {
  for (const path of paths) {
    let cursor: any = payload;
    for (const part of path.split('.')) {
      cursor = cursor?.[part];
      if (cursor === undefined || cursor === null) break;
    }
    const value = typeof cursor === 'number' ? String(cursor) : str(cursor);
    if (value) return value;
  }
  return null;
}

/**
 * Maps a vendor's own word for "how bad" onto three levels.
 *
 * Three rather than each vendor's five or six: the only decision this drives
 * is whether to open a ticket and how loudly, and nobody can hold six levels
 * in their head consistently at three in the morning.
 */
function severityFrom(value: string | null, fallback: AlertSeverity = 'warning'): AlertSeverity {
  const text = (value ?? '').toLowerCase();
  if (!text) return fallback;
  if (/crit|fatal|disaster|sev-?[01]\b|emergency|p1\b|high|error|failure|failed|down/.test(text)) return 'critical';
  if (/warn|degrad|minor|sev-?[23]\b|medium|p2\b|unstable/.test(text)) return 'warning';
  if (/info|ok|resolved|success|low|notice/.test(text)) return 'info';
  return fallback;
}

/** A dedupe key that is stable for one condition and unique across sources. */
function key(...parts: Array<string | null | undefined>): string {
  const joined = parts.filter(Boolean).join(':').toLowerCase().replace(/\s+/g, '-');
  return joined.slice(0, 190) || 'unkeyed';
}

/* ------------------------------ DigitalOcean ------------------------------ */

/**
 * DigitalOcean monitoring alerts.
 *
 * One webhook fires for a policy against one or more droplets, and the same
 * policy re-fires while the condition holds - so the policy plus the droplet
 * is the condition, not the delivery.
 */
function digitalocean(payload: Payload): ParseResult {
  const policy = pick(payload, 'alert.description', 'alert_policy.description', 'policy.description') ?? 'Alert';
  const uuid = pick(payload, 'alert.uuid', 'alert_policy.uuid', 'policy.uuid');
  const resolved = /resolved|ok/i.test(pick(payload, 'alert.status', 'status') ?? '');

  const droplets: any[] = Array.isArray(payload.droplets)
    ? payload.droplets
    : Array.isArray(payload.resources)
      ? payload.resources
      : [];

  if (droplets.length === 0) {
    return {
      kind: 'alerts',
      alerts: [
        {
          dedupeKey: key('do', uuid ?? policy),
          title: `DigitalOcean: ${policy}`,
          body: pick(payload, 'alert.compare', 'alert.value'),
          severity: resolved ? 'info' : 'warning',
          status: resolved ? 'resolved' : 'firing',
        },
      ],
    };
  }

  return {
    kind: 'alerts',
    alerts: droplets.map((droplet) => {
      const name = str(droplet?.name) ?? str(droplet?.id) ?? 'droplet';
      return {
        dedupeKey: key('do', uuid ?? policy, name),
        title: `DigitalOcean: ${policy} on ${name}`,
        body: pick(payload, 'alert.compare', 'alert.value'),
        severity: resolved ? 'info' : 'warning',
        status: resolved ? 'resolved' : 'firing',
        resource: name,
      };
    }),
  };
}

/* --------------------------------- Jenkins -------------------------------- */

/**
 * Jenkins build notifications.
 *
 * Keyed on the job, not the build number: the condition is "this job is
 * broken", and a job failing five builds running is one problem. A SUCCESS
 * on the same job is what resolves it, which is how a fixed build closes its
 * own ticket.
 */
function jenkins(payload: Payload): ParseResult {
  const job = pick(payload, 'name', 'job_name', 'build.full_url', 'displayName') ?? 'job';
  const number = pick(payload, 'build.number', 'number');
  const phase = (pick(payload, 'build.phase', 'phase') ?? '').toUpperCase();
  const result = (pick(payload, 'build.status', 'build.result', 'status', 'result') ?? '').toUpperCase();
  const url = pick(payload, 'build.full_url', 'build.url', 'url');

  // Only the end of a build says anything; STARTED is noise.
  if (phase && phase !== 'FINALIZED' && phase !== 'COMPLETED' && !result) {
    return { kind: 'ignored', reason: `Jenkins phase ${phase}` };
  }

  const good = result === 'SUCCESS' || result === 'STABLE';
  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('jenkins', job),
        title: good ? `Jenkins: ${job} is green again` : `Jenkins: ${job} ${result || 'failed'}`,
        body: number ? `Build #${number}` : null,
        severity: good ? 'info' : result === 'UNSTABLE' ? 'warning' : 'critical',
        status: good ? 'resolved' : 'firing',
        resource: job,
        externalUrl: url,
      },
    ],
  };
}

/* ---------------------------------- Azure --------------------------------- */

/** Azure Monitor's common alert schema, and its older shape as a fallback. */
function azure(payload: Payload): ParseResult {
  const essentials = payload?.data?.essentials ?? payload?.data?.context ?? {};
  const rule =
    str(essentials.alertRule) ??
    pick(payload, 'data.context.name', 'data.context.conditionType') ??
    'Azure alert';
  const ruleId = str(essentials.alertId) ?? str(essentials.alertRule) ?? rule;

  const targets: string[] = Array.isArray(essentials.alertTargetIDs) ? essentials.alertTargetIDs : [];
  const resource = targets[0]?.split('/').pop() ?? pick(payload, 'data.context.resourceName');

  // "Resolved" and "Deactivated" both mean the condition has cleared.
  const state = (str(essentials.monitorCondition) ?? str(essentials.alertState) ?? '').toLowerCase();
  const resolved = /resolved|deactivated/.test(state);

  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('azure', ruleId, resource),
        title: `Azure: ${rule}${resource ? ` on ${resource}` : ''}`,
        body: str(essentials.description) ?? pick(payload, 'data.context.description'),
        severity: resolved ? 'info' : severityFrom(str(essentials.severity), 'critical'),
        status: resolved ? 'resolved' : 'firing',
        resource,
        externalUrl: pick(payload, 'data.alertContext.portalLink', 'data.context.portalLink'),
      },
    ],
  };
}

/* ----------------------------------- AWS ---------------------------------- */

/**
 * CloudWatch alarms, which arrive wrapped in SNS.
 *
 * SNS will not deliver anything until the subscription is confirmed, and that
 * confirmation arrives as a different message type at the same URL - so it is
 * handled here rather than requiring somebody to go and click a link.
 */
function aws(payload: Payload): ParseResult {
  if (payload?.Type === 'SubscriptionConfirmation' && str(payload.SubscribeURL)) {
    return { kind: 'confirm', url: String(payload.SubscribeURL) };
  }
  if (payload?.Type === 'UnsubscribeConfirmation') {
    return { kind: 'ignored', reason: 'SNS unsubscribe confirmation' };
  }

  // The alarm itself is a JSON string inside the SNS envelope.
  let message: Payload = payload;
  if (payload?.Type === 'Notification' && typeof payload.Message === 'string') {
    try {
      message = JSON.parse(payload.Message);
    } catch {
      return {
        kind: 'alerts',
        alerts: [
          {
            dedupeKey: key('aws', str(payload.Subject) ?? 'sns'),
            title: `AWS: ${str(payload.Subject) ?? 'notification'}`,
            body: String(payload.Message).slice(0, 2000),
            severity: 'warning',
            status: 'firing',
          },
        ],
      };
    }
  }

  const name = pick(message, 'AlarmName', 'alarmName') ?? 'CloudWatch alarm';
  const state = (pick(message, 'NewStateValue', 'newStateValue') ?? '').toUpperCase();
  const region = pick(message, 'Region', 'region');

  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('aws', name, region),
        title: `AWS: ${name} is ${state || 'in alarm'}`,
        body: pick(message, 'NewStateReason', 'newStateReason'),
        severity: state === 'OK' ? 'info' : state === 'INSUFFICIENT_DATA' ? 'warning' : 'critical',
        status: state === 'OK' ? 'resolved' : 'firing',
        resource: pick(message, 'Trigger.Dimensions.0.value', 'AlarmDescription') ?? region,
      },
    ],
  };
}

/* ------------------------------- CrowdStrike ------------------------------ */

/**
 * CrowdStrike detections.
 *
 * Keyed on the detection id rather than the host: two separate detections on
 * one machine are two things to look at, and collapsing them would hide the
 * second. Nothing here auto-resolves - a detection is closed by a person
 * deciding it is dealt with, which is the ticket being closed.
 */
function crowdstrike(payload: Payload): ParseResult {
  const event = payload?.event ?? payload;
  const detectId = pick(event, 'DetectId', 'detection_id', 'CompositeId', 'id');
  const host = pick(event, 'ComputerName', 'Hostname', 'device.hostname', 'hostname');
  const tactic = pick(event, 'Tactic', 'tactic');
  const technique = pick(event, 'Technique', 'technique');
  const severityName = pick(event, 'SeverityName', 'severity_name', 'Severity', 'severity');

  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('cs', detectId ?? `${host}-${technique}`),
        title: `CrowdStrike: ${technique ?? tactic ?? 'detection'}${host ? ` on ${host}` : ''}`,
        body: [pick(event, 'DetectDescription', 'description'), tactic && `Tactic: ${tactic}`]
          .filter(Boolean)
          .join('\n'),
        // A security detection defaults to critical when unlabelled: the cost
        // of over-reacting is a wasted look, the other way is a breach.
        severity: severityFrom(severityName, 'critical'),
        status: 'firing',
        resource: host,
        externalUrl: pick(event, 'FalconHostLink', 'falcon_host_link'),
      },
    ],
  };
}

/* --------------------------------- Ansible -------------------------------- */

/** AWX / Ansible Tower job notifications. */
function ansible(payload: Payload): ParseResult {
  const name = pick(payload, 'name', 'job.name', 'job_friendly_name') ?? 'playbook';
  const status = (pick(payload, 'status', 'job.status') ?? '').toLowerCase();
  const failed = pick(payload, 'body') ?? '';
  const good = status === 'successful' || status === 'ok';

  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('ansible', name),
        title: good ? `Ansible: ${name} succeeded` : `Ansible: ${name} ${status || 'failed'}`,
        body: typeof failed === 'string' ? failed.slice(0, 2000) : null,
        severity: good ? 'info' : 'critical',
        status: good ? 'resolved' : 'firing',
        resource: name,
        externalUrl: pick(payload, 'url', 'job.url'),
      },
    ],
  };
}

/* --------------------------- Linux and Windows ---------------------------- */

/**
 * Servers reporting for themselves.
 *
 * There is no single agent to conform to, so this takes the plain shape a
 * shell script or a scheduled task can produce with the tools already on the
 * box - curl and PowerShell respectively - and is documented as such. It also
 * reads the common Prometheus Alertmanager fields, since that is what a Linux
 * fleet most often already has.
 */
function server(kind: 'linux' | 'windows') {
  return (payload: Payload): ParseResult => {
    // Alertmanager posts a batch under `alerts`.
    if (Array.isArray(payload?.alerts)) {
      return {
        kind: 'alerts',
        alerts: payload.alerts.map((item: Payload) => {
          const name = pick(item, 'labels.alertname') ?? 'alert';
          const instance = pick(item, 'labels.instance', 'labels.host');
          const resolved = (str(item?.status) ?? '').toLowerCase() === 'resolved';
          return {
            dedupeKey: key(kind, name, instance),
            title: `${instance ?? kind}: ${name}`,
            body: pick(item, 'annotations.description', 'annotations.summary'),
            severity: resolved ? 'info' : severityFrom(pick(item, 'labels.severity')),
            status: resolved ? 'resolved' : 'firing',
            resource: instance,
            externalUrl: pick(item, 'generatorURL'),
          };
        }),
      };
    }

    const host = pick(payload, 'host', 'hostname', 'computer', 'ComputerName') ?? 'server';
    const check = pick(payload, 'check', 'name', 'event', 'Source') ?? 'check';
    const state = pick(payload, 'state', 'status', 'EntryType');
    const resolved = /ok|resolved|recovered|clear/i.test(state ?? '');

    return {
      kind: 'alerts',
      alerts: [
        {
          dedupeKey: key(kind, host, check),
          title: `${host}: ${check}`,
          body: pick(payload, 'message', 'Message', 'description', 'output'),
          severity: resolved ? 'info' : severityFrom(state ?? pick(payload, 'severity', 'Level')),
          status: resolved ? 'resolved' : 'firing',
          resource: host,
        },
      ],
    };
  };
}

/* --------------------------------- Generic -------------------------------- */

/**
 * Anything else.
 *
 * A deliberate escape hatch: a system nobody has written an adapter for is
 * better ingested imperfectly than not at all, and this is also the shape the
 * documentation tells people to send when they are writing the sender
 * themselves.
 */
function generic(payload: Payload): ParseResult {
  const title = pick(payload, 'title', 'subject', 'summary', 'message', 'name') ?? 'Alert';
  const status = (pick(payload, 'status', 'state') ?? 'firing').toLowerCase();

  return {
    kind: 'alerts',
    alerts: [
      {
        dedupeKey: key('generic', pick(payload, 'dedupeKey', 'dedupe_key', 'fingerprint', 'id') ?? title),
        title,
        body: pick(payload, 'body', 'description', 'detail'),
        severity: severityFrom(pick(payload, 'severity', 'priority', 'level')),
        status: /resolved|ok|recovered|cleared/.test(status) ? 'resolved' : 'firing',
        resource: pick(payload, 'resource', 'host', 'service'),
        externalUrl: pick(payload, 'url', 'link'),
      },
    ],
  };
}

const ADAPTERS: Record<AlertSourceKind, (payload: Payload) => ParseResult> = {
  digitalocean,
  jenkins,
  azure,
  aws,
  crowdstrike,
  ansible,
  linux: server('linux'),
  windows: server('windows'),
  // Neither heartbeats nor probes arrive through the ingest endpoint: one is
  // a check-in URL, the other is raised by this system calling outwards.
  heartbeat: generic,
  probe: generic,
  generic,
};

export function parseAlert(kind: AlertSourceKind, payload: unknown): ParseResult {
  const adapter = ADAPTERS[kind] ?? generic;
  if (!payload || typeof payload !== 'object') {
    return { kind: 'ignored', reason: 'Body was not a JSON object' };
  }
  try {
    const result = adapter(payload as Payload);
    if (result.kind === 'alerts' && result.alerts.length === 0) {
      return { kind: 'ignored', reason: 'Nothing alertable in that payload' };
    }
    return result;
  } catch (error) {
    /*
     * A vendor changing its payload must not take the endpoint down. The
     * generic reading of it is better than a 500 and a lost alert.
     */
    return generic(payload as Payload);
  }
}
