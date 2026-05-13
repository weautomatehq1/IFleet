#!/usr/bin/env node
// Usage: RESEND_API_KEY=re_xxx node --import tsx scripts/smoke-email.ts
// Sends a hello email to weautomatehq1@gmail.com to verify the Resend integration.

import { sendEmail } from '../src/utils/email.js';

const TO = 'weautomatehq1@gmail.com';

const { id } = await sendEmail({
  to: TO,
  subject: 'IFleet smoke test — Resend wired',
  html: `
    <h2>Resend integration smoke test</h2>
    <p>If you received this, the Resend email integration is working.</p>
    <p><strong>Sent at:</strong> ${new Date().toISOString()}</p>
  `,
});

console.log(`Sent — id: ${id}`);
