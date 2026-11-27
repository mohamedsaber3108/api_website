import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { creditLedger, invoices, payments } from '../../../db/schema';
import { requireUser } from '../../../lib/server/auth';
import { CREDIT_PACKAGES, features } from '../../../lib/server/config';
import { inferenceEnabled } from '../../../lib/server/flags';
import { handle, json } from '../../../lib/server/http';
import { getBalanceSummary } from '../../../lib/server/ledger';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  const user = await requireUser(request);
  const db = getDb();
  const [summary, transactions, paymentRows, invoiceRows] = await Promise.all([
    getBalanceSummary(user.userId),
    db
      .select({ id: creditLedger.id, deltaMicroUsd: creditLedger.deltaMicroUsd, type: creditLedger.type, note: creditLedger.note, createdAt: creditLedger.createdAt })
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.userId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(50),
    db
      .select({ id: payments.id, amountMinor: payments.amountMinor, currency: payments.currency, creditMicroUsd: payments.creditMicroUsd, status: payments.status, refundedMinor: payments.refundedMinor, createdAt: payments.createdAt })
      .from(payments)
      .where(eq(payments.userId, user.userId))
      .orderBy(desc(payments.createdAt))
      .limit(20),
    db
      .select({ id: invoices.id, number: invoices.number, amountMinor: invoices.amountMinor, currency: invoices.currency, description: invoices.description, status: invoices.status, issuedAt: invoices.issuedAt })
      .from(invoices)
      .where(eq(invoices.userId, user.userId))
      .orderBy(desc(invoices.issuedAt))
      .limit(20),
  ]);
  return json({ balanceMicroUsd: summary.balanceMicroUsd, heldMicroUsd: summary.heldMicroUsd, availableMicroUsd: summary.availableMicroUsd, packages: CREDIT_PACKAGES, checkoutEnabled: features.billing(), inferenceEnabled: await inferenceEnabled(), emailVerified: user.emailVerified, transactions, payments: paymentRows, invoices: invoiceRows });
});
