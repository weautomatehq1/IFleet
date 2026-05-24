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

const DEFAULT_FROM = 'IFleet <onboarding@resend.dev>';

function getClient(): Resend {
  const key = process.env['RESEND_API_KEY'];
  if (!key) throw new Error('RESEND_API_KEY is not set');
  return new Resend(key);
}

export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
  for (const addr of recipients) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      throw new Error(`Invalid email address: ${addr}`);
    }
  }
  const client = getClient();
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
    html: `<p><strong>Sprint:</strong> ${opts.sprintId}</p><pre>${opts.body}</pre>`,
  });
}
