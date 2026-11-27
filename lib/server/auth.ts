import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../db';
import { accounts, authTokens, sessions } from '../../db/schema';
import { adminEmails, features, SESSION_COOKIE, SESSION_TTL_MS } from './config';
import { randomHex, sha256Hex } from './crypto';
import { clientIp, cookieHeader, HttpError, readCookie } from './http';
import { assertAdminMfa } from './mfa';

export type Role = 'customer' | 'support' | 'admin';

export type Principal = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  provider: 'password' | 'chatgpt';
  emailVerified: boolean;
  sessionId: string | null;
  /** When this session last passed MFA; null if never (or for hosted ChatGPT identity, which has no session). */
  mfaVerifiedAt: number | null;
};

const USER_ID_HEADER = 'oai-authenticated-user-id';
const USER_EMAIL_HEADER = 'oai-authenticated-user-email';
const USER_FULL_NAME_HEADER = 'oai-authenticated-user-full-name';
const USER_FULL_NAME_ENCODING_HEADER = 'oai-authenticated-user-full-name-encoding';

function effectiveRole(role: string, email: string, verified: boolean): Role {
  if (verified && adminEmails().has(email.toLowerCase())) return 'admin';
  return role === 'admin' || role === 'support' ? (role as Role) : 'customer';
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Resolves the caller from a Wasl session cookie, then the hosted ChatGPT identity headers. */
export async function getPrincipal(request: Request): Promise<Principal | null> {
  const db = getDb();
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const id = await sha256Hex(token);
    const now = Date.now();
    const [row] = await db
      .select({ s: sessions, a: accounts })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.userId, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
      .limit(1);
    if (row && row.a.status === 'active') {
      if (now - row.s.lastSeenAt > 10 * 60 * 1000) {
        await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
      }
      const verified = !!row.a.emailVerifiedAt;
      return {
        userId: row.a.userId,
        email: row.a.email,
        name: row.a.name || row.a.email,
        role: effectiveRole(row.a.role, row.a.email, verified),
        provider: 'password',
        emailVerified: verified,
        sessionId: id,
        mfaVerifiedAt: row.s.mfaVerifiedAt,
      };
    }
  }

  // These headers are only trustworthy when a hosting platform sets them and strips client-sent
  // copies. On any other host (EC2, VPS) a client could forge them, so they are ignored by default.
  const chatgptId = features.chatgptIdentity() ? request.headers.get(USER_ID_HEADER) : null;
  const chatgptEmail = features.chatgptIdentity() ? request.headers.get(USER_EMAIL_HEADER) : null;
  if (chatgptId && chatgptEmail) {
    const encoded = request.headers.get(USER_FULL_NAME_HEADER);
    const fullName = encoded && request.headers.get(USER_FULL_NAME_ENCODING_HEADER) === 'percent-encoded-utf-8' ? safeDecode(encoded) : null;
    const now = Date.now();
    await db
      .insert(accounts)
      .values({ userId: chatgptId, email: chatgptEmail.toLowerCase(), createdAt: now, name: fullName, authProvider: 'chatgpt', emailVerifiedAt: now })
      .onConflictDoNothing();
    const [a] = await db.select().from(accounts).where(eq(accounts.userId, chatgptId)).limit(1);
    if (a && a.status === 'active') {
      return {
        userId: a.userId,
        email: a.email,
        name: a.name || fullName || a.email,
        role: effectiveRole(a.role, a.email, true),
        provider: 'chatgpt',
        emailVerified: true,
        sessionId: null,
        mfaVerifiedAt: null,
      };
    }
  }
  return null;
}

export async function requireUser(request: Request): Promise<Principal> {
  const p = await getPrincipal(request);
  if (!p) throw new HttpError(401, 'Sign in required', 'sign_in_required');
  return p;
}

export async function requireRole(request: Request, ...roles: Role[]): Promise<Principal> {
  const p = await requireUser(request);
  if (!roles.includes(p.role)) throw new HttpError(403, 'Forbidden', 'forbidden');
  // Admins also need an MFA-verified session. Support staff are not required yet (SEC-3b).
  if (p.role === 'admin') await assertAdminMfa(p);
  return p;
}

/** Like requireUser, but for the MFA routes: an admin with a real session cookie (hosted ChatGPT identity has none). */
export async function requireAdminSession(request: Request): Promise<Principal & { sessionId: string }> {
  const p = await requireUser(request);
  if (p.role !== 'admin' || !p.sessionId) throw new HttpError(403, 'Forbidden', 'forbidden');
  return p as Principal & { sessionId: string };
}

/** Creates a session row and returns the Set-Cookie header value. */
export async function createSession(request: Request, userId: string): Promise<string> {
  const token = randomHex(32);
  const now = Date.now();
  await getDb().insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ip: clientIp(request),
    userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
  });
  return cookieHeader(request, SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
}

export function clearSessionCookie(request: Request): string {
  return cookieHeader(request, SESSION_COOKIE, '', 0);
}

/** Issues a single-use token and returns the raw value (only the hash is stored). */
export async function createAuthToken(userId: string, type: 'verify_email' | 'reset_password', ttlMs: number): Promise<string> {
  const raw = randomHex(32);
  const now = Date.now();
  const db = getDb();
  // Invalidate earlier unused tokens of the same type.
  await db.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.usedAt)));
  await db.insert(authTokens).values({ id: crypto.randomUUID(), userId, type, hash: await sha256Hex(raw), createdAt: now, expiresAt: now + ttlMs });
  return raw;
}

/** Atomically marks a valid token as used and returns its user id. */
export async function consumeAuthToken(raw: string, type: 'verify_email' | 'reset_password'): Promise<string | null> {
  const now = Date.now();
  const rows = await getDb()
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.hash, await sha256Hex(raw)), eq(authTokens.type, type), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning({ userId: authTokens.userId });
  return rows[0]?.userId ?? null;
}

export function publicUser(p: Principal) {
  return { id: p.userId, email: p.email, name: p.name, role: p.role, provider: p.provider, emailVerified: p.emailVerified };
}
