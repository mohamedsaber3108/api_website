import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../../../db';
import { accounts, invoices } from '../../../../../db/schema';
import { requireUser } from '../../../../../lib/server/auth';
import { escapeHtml } from '../../../../../lib/server/email';
import { fail, handle } from '../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/** Printable HTML invoice (use the browser's "Save as PDF"). */
export const GET = handle<{ id: string }>(async (request, ctx) => {
  const user = await requireUser(request);
  const { id } = await ctx.params;
  const db = getDb();
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.userId, user.userId))).limit(1);
  if (!inv) return fail(404, 'Invoice not found', 'not_found');
  const [acct] = await db.select({ name: accounts.name, email: accounts.email }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
  const amount = (inv.amountMinor / 100).toFixed(2);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(inv.number)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#111}h1{margin:0}table{width:100%;border-collapse:collapse;margin-top:32px}td,th{padding:10px 0;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}.muted{color:#666}@media print{button{display:none}}</style></head><body>
<h1>Wasl AI</h1><p class="muted">Invoice ${escapeHtml(inv.number)}<br>Issued ${new Date(inv.issuedAt).toISOString().slice(0, 10)} · Status: ${escapeHtml(inv.status)}</p>
<p><strong>Billed to</strong><br>${escapeHtml(acct?.name || '')}<br>${escapeHtml(acct?.email || '')}</p>
<table><tr><th>Description</th><th>Amount (${escapeHtml(inv.currency.toUpperCase())})</th></tr><tr><td>${escapeHtml(inv.description)}</td><td>${amount}</td></tr><tr><th>Total</th><th>${amount}</th></tr></table>
<p class="muted">Prepaid credits. Taxes are not itemised on this document.</p><button onclick="print()">Print / Save as PDF</button></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
});
