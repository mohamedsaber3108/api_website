import { env } from 'cloudflare:workers';
import { features, isProduction } from './config';

export type Mail = { to: string; subject: string; text: string; html?: string };

/**
 * Sends through Resend when configured. Without a provider the message is
 * logged (non-production only) so flows stay testable. Never throws.
 */
export async function sendEmail(mail: Mail): Promise<{ delivered: boolean }> {
  if (!features.email()) {
    if (!isProduction()) console.log(`[email:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    return { delivered: false };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('email provider error', res.status);
    return { delivered: res.ok };
  } catch (e) {
    console.error('email send failed', e instanceof Error ? e.message : e);
    return { delivered: false };
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
