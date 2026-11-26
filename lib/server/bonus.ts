import { eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { creditLedger } from '../../db/schema';
import { signupBonusMicroUsd } from './config';
import { sha256Hex } from './crypto';
import { addLedgerEntry } from './ledger';

/**
 * One address, many spellings: lower case, no "+tag", and for Gmail no dots and googlemail = gmail.
 * shortcut: only the Gmail rules are known; other providers' aliases and disposable domains still pass.
 */
export function normalizeEmail(email: string): string {
  const [rawLocal = '', rawDomain = ''] = email.trim().toLowerCase().split('@');
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain;
  let local = rawLocal.split('+')[0] || rawLocal;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/**
 * Grants the sign-up credit once per verified e-mail. The ledger idempotency key is global and unique,
 * so the key `bonus:email:<sha256 of the normalised address>` is the whole rule: no schema change.
 * Returns true only when this call created the credit.
 */
export async function grantSignupBonus(userId: string, email: string): Promise<boolean> {
  const amount = signupBonusMicroUsd();
  if (amount <= 0) return false;
  // Accounts created before this change already got a credit at registration under this key.
  const [legacy] = await getDb().select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.idempotencyKey, `bonus:signup:${userId}`)).limit(1);
  if (legacy) return false;
  const hash = await sha256Hex(normalizeEmail(email));
  return addLedgerEntry({ userId, deltaMicroUsd: amount, type: 'bonus', idempotencyKey: `bonus:email:${hash}`, note: 'Sign-up credit' });
}
