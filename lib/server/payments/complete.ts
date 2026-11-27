import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { accounts, invoices, payments } from '../../../db/schema';
import { audit } from '../audit';
import { sendEmail } from '../email';
import { ledgerInsert } from '../ledger';

/**
 * Marks a payment paid, credits the ledger and writes the invoice. Idempotent: a payment already paid or refunded
 * is skipped, and the ledger key `topup:<paymentId>` is unique. Used by the Stripe webhook and the dev stub.
 */
export async function completePayment(paymentId: string, intent: string | null) {
  const db = getDb();
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) return;
  if (p.status === 'paid' || p.status === 'refunded' || p.status === 'partially_refunded') return;
  const now = Date.now();
  const number = `INV-${new Date(now).toISOString().slice(0, 7).replace('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // One atomic batch: payment state, ledger credit (idempotent), invoice.
  await db.batch([
    db.update(payments).set({ status: 'paid', completedAt: now, providerPaymentIntent: intent }).where(and(eq(payments.id, p.id), eq(payments.status, p.status))),
    ledgerInsert({ userId: p.userId, deltaMicroUsd: p.creditMicroUsd, type: 'topup', idempotencyKey: `topup:${p.id}`, refType: 'payment', refId: p.id, note: 'Credit purchase' }),
    db.insert(invoices).values({ id: crypto.randomUUID(), number, userId: p.userId, paymentId: p.id, amountMinor: p.amountMinor, currency: p.currency, description: `Wasl AI credits ($${(p.creditMicroUsd / 1e6).toFixed(2)})`, status: 'paid', issuedAt: now }).onConflictDoNothing(),
  ]);
  const [acct] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
  if (acct) await sendEmail({ to: acct.email, subject: `Wasl AI receipt ${number}`, text: `Thanks. We added $${(p.creditMicroUsd / 1e6).toFixed(2)} in credits to your account.\nInvoice: ${number}` });
  await audit(null, p.userId, 'billing.payment_completed', { type: 'payment', id: p.id });
}
