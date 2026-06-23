import { Resend } from 'resend';

export interface EmailPayload {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

export interface EmailResult {
  id: string;
}

const DEFAULT_FROM = process.env['IFLEET_EMAIL_FROM'] ?? 'IFleet <onboarding@resend.dev>';

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    const key = process.env['RESEND_API_KEY'];
    if (!key) throw new Error('RESEND_API_KEY is not set');
    _resend = new Resend(key);
  }
  return _resend;
}

/**
 * Escape a plain-text string for safe interpolation into an HTML body. Used by
 * every callsite that mixes user-controlled values (sprint IDs, PR titles,
 * failure summaries) into the `html` field of an outbound email. Without this
 * a sprint title containing `<script>…</script>` or attribute-breaker
 * characters would render as live HTML in the recipient's mail client.
 * Closes AUDIT-IFleet-98e63c5e.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
  for (const addr of recipients) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      throw new Error(`Invalid email address: ${addr}`);
    }
  }
  const client = getResend();
  const { data, error } = await client.emails.send({
    from: payload.from ?? DEFAULT_FROM,
    to: Array.isArray(payload.to) ? payload.to : [payload.to],
    subject: payload.subject,
    html: payload.html,
    replyTo: payload.replyTo,
  });
  if (error !== null && error !== undefined) {
    throw new Error(`Resend API error: ${error.message}`);
  }
  if (data === null || data === undefined) {
    throw new Error('Resend returned no data and no error');
  }
  return { id: data.id };
}

export async function sendSprintAlert(opts: {
  to: string;
  sprintId: string;
  subject: string;
  body: string;
}): Promise<EmailResult> {
  return sendEmail({
    to: opts.to,
    subject: `[IFleet] ${opts.subject}`,
    html: `<p><strong>Sprint:</strong> ${escapeHtml(opts.sprintId)}</p><pre>${escapeHtml(opts.body)}</pre>`,
  });
}
