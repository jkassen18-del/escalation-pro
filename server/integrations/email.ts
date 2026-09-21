import nodemailer, { type Transporter } from 'nodemailer';
import type { DeliveryResult, NotificationContext, TestResult } from './types.ts';
import type { IntegrationRecord } from './store.ts';
import { PRIORITY_HEX } from './types.ts';

export interface EmailConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  fromName?: string;
  fromEmail?: string;
  /** Always copied on every notification, in addition to the ticket's people. */
  alwaysNotify?: string[];
}

function buildTransport(config: EmailConfig): Transporter {
  const port = Number(config.port || 587);
  return nodemailer.createTransport({
    host: config.host,
    port,
    // Port 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: config.secure ?? port === 465,
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

function fromAddress(config: EmailConfig): string {
  const address = config.fromEmail || config.username || 'no-reply@localhost';
  return config.fromName ? `"${config.fromName}" <${address}>` : address;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Plain, table-based HTML. Email clients are not browsers - no flexbox, no
 * external CSS, inline styles only.
 */
function buildHtml(ctx: NotificationContext): string {
  const { ticket } = ctx;
  const rows: Array<[string, string]> = [
    ['Reference', ticket.reference],
    ['Status', ticket.status.replace('_', ' ')],
    ['Priority', ticket.priority],
    ['Team', ticket.teamName ?? 'Unassigned'],
    ['Assignee', ticket.assigneeName ?? 'Unassigned'],
    ['Updated by', ctx.actorName],
  ];

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:6px">
    <tr><td style="height:4px;background:${PRIORITY_HEX[ticket.priority] ?? '#667085'};border-radius:6px 6px 0 0"></td></tr>
    <tr><td style="padding:24px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#78716c">${escapeHtml(ctx.headline)}</p>
      <h1 style="margin:0 0 20px;font-size:18px;font-weight:600;line-height:1.4">${escapeHtml(ticket.subject)}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:13px;border-collapse:collapse">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 0;color:#78716c;width:110px">${label}</td><td style="padding:6px 0;font-weight:500">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}
      </table>
      ${
        ctx.detail
          ? `<div style="margin-top:18px;padding:12px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:4px;font-size:13px;white-space:pre-wrap">${escapeHtml(ctx.detail.slice(0, 4000))}</div>`
          : ''
      }
      <p style="margin:24px 0 0">
        <a href="${ctx.ticketUrl}" style="display:inline-block;padding:9px 16px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:4px;font-size:13px;font-weight:500">Open ticket</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function buildText(ctx: NotificationContext): string {
  return [
    ctx.headline,
    '',
    `${ctx.ticket.reference}: ${ctx.ticket.subject}`,
    `Status: ${ctx.ticket.status}`,
    `Priority: ${ctx.ticket.priority}`,
    `Team: ${ctx.ticket.teamName ?? 'Unassigned'}`,
    `Assignee: ${ctx.ticket.assigneeName ?? 'Unassigned'}`,
    ctx.detail ? `\n${ctx.detail}` : '',
    '',
    ctx.ticketUrl,
  ].join('\n');
}

export async function testEmail(record: IntegrationRecord, recipient?: string): Promise<TestResult> {
  const config = record.config as EmailConfig;
  if (!config.host) return { ok: false, message: 'An SMTP host is required.' };

  try {
    const transport = buildTransport(config);
    await transport.verify();

    const to = recipient || config.fromEmail || config.username;
    if (!to) {
      return { ok: true, message: 'SMTP credentials verified. Set a from-address to send test mail.' };
    }

    const info = await transport.sendMail({
      from: fromAddress(config),
      to,
      subject: 'Escalation Pro SMTP test',
      text: 'Escalation Pro connected to this mail server successfully.',
      html: '<p>Escalation Pro connected to this mail server successfully.</p>',
    });

    return { ok: true, message: `SMTP verified and a test message was sent to ${to}.`, details: { messageId: info.messageId } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendEmail(
  record: IntegrationRecord,
  ctx: NotificationContext,
  recipients: string[],
): Promise<DeliveryResult> {
  const config = record.config as EmailConfig;
  const to = Array.from(new Set([...recipients, ...(config.alwaysNotify ?? [])].filter(Boolean)));

  if (!config.host) return { ok: false, statusCode: null, error: 'SMTP host is not configured' };
  if (!to.length) return { ok: true, statusCode: null, error: null }; // nothing to do

  try {
    const transport = buildTransport(config);
    await transport.sendMail({
      from: fromAddress(config),
      to,
      subject: `[${ctx.ticket.reference}] ${ctx.headline}`,
      text: buildText(ctx),
      html: buildHtml(ctx),
    });
    return { ok: true, statusCode: 200, error: null };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
}
