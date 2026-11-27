import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { accounts, invoices, payments } from '../../../db/schema';
import { audit } from '../audit';
import { sendEmail } from '../email';
import { ledgerInsert } from '../ledger';

/** The amount or currency the provider reports is not what we stored. Nothing was credited or marked paid. */
export class PaymentMismatchError extends Error {
  constructor() {
    super('Paid amount does not match the stored payment');
  }
}

/**
 * Marks a payment paid, credits the ledger and writes the invoice. Idempotent: a payment already paid or refunded
 * is skipped, and the ledger key `topup:<paymentId>` is unique. Used by the Stripe webhook and the dev stub.
 *
 * `paid` is what the provider says was charged. It must equal the stored payment (amount and currency), or this
 * throws PaymentMismatchError and changes nothing (the webhook then answers 500, so the provider retries and the
 * failure is stored on the event row).
 *
 * Returns true only for the one call that moved the payment to paid; that call alone sends the receipt mail.
 * The claim is the conditional UPDATE ... WHERE status = <status we read> RETURNING id: D1 runs batches one at a
 * time, so of several parallel calls only one gets a row back.
 */
export async function completePayment(paymentId: string, intent: string | null, paid: { amountMinor: number; currency: string }): Promise<boolean> {
  const db = getDb();
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) return false;
  if (p.status === 'paid' || p.status === 'refunded' || p.status === 'partially_refunded') return false;
  if (paid.amountMinor !== p.amountMinor || paid.currency.toLowerCase() !== p.currency.toLowerCase()) {
    console.error(`payment mismatch id=${p.id} expected=${p.amountMinor} ${p.currency} got=${paid.amountMinor} ${paid.currency}`);
    throw new PaymentMismatchError();
  }
  const now = Date.now();
  const number = `INV-${new Date(now).toISOString().slice(0, 7).replace('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // One atomic batch: payment state (the claim), ledger credit (idempotent), invoice.
  const [claimed] = await db.batch([
    db.update(payments).set({ status: 'paid', completedAt: now, providerPaymentIntent: intent }).where(and(eq(payments.id, p.id), eq(payments.status, p.status))).returning({ id: payments.id }),
    ledgerInsert({ userId: p.userId, deltaMicroUsd: p.creditMicroUsd, type: 'topup', idempotencyKey: `topup:${p.id}`, refType: 'payment', refId: p.id, note: 'Credit purchase' }),
    db.insert(invoices).values({ id: crypto.randomUUID(), number, userId: p.userId, paymentId: p.id, amountMinor: p.amountMinor, currency: p.currency, description: `Wasl AI credits ($${(p.creditMicroUsd / 1e6).toFixed(2)})`, status: 'paid', issuedAt: now }).onConflictDoNothing(),
  ]);
  if (claimed.length !== 1) return false; // another call won the claim; it sends the mail
  const [acct] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
  const paidText = `${(p.amountMinor / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
  if (acct) await sendEmail({ to: acct.email, subject: `Wasl AI receipt ${number}`, text: `Thanks. We added $${(p.creditMicroUsd / 1e6).toFixed(2)} in credits to your account.\nYou paid ${paidText}.\nInvoice: ${number}\n\nشكرًا لك. المبلغ المدفوع: ${paidText}` });
  await audit(null, p.userId, 'billing.payment_completed', { type: 'payment', id: p.id });
  return true;
}
