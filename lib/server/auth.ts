import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../db';
import { accounts, authTokens, sessions } from '../../db/schema';
import { audit, auditDeniedOnce } from './audit';
import { adminEmails, adminEmailsBreakGlass, features, SESSION_COOKIE, SESSION_TTL_MS, STAFF_ABSOLUTE_MS, STAFF_IDLE_MS, STAFF_TOUCH_MS } from './config';
import { randomHex, sha256Hex } from './crypto';
import { clientIp, cookieHeader, HttpError, readCookie } from './http';
import { assertAdminMfa } from './mfa';

export type Role = 'customer' | 'support' | 'admin' | 'super_admin';

export const isAdminRole = (r: Role) => r === 'admin' || r === 'super_admin';
/** Staff = support, admin, super_admin. They need MFA and have session time limits (SEC-3b). */
export const isStaffRole = (r: Role) => r === 'support' || isAdminRole(r);

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
  /** True when `admin` came only from ADMIN_EMAILS while a super_admin exists (break-glass). Every admin request then writes an audit row. */
  breakGlass: boolean;
  /** Only for a staff session cookie: when the idle limit and the absolute limit end this session. */
  sessionEnds?: { idleEndsAt: number; absoluteEndsAt: number };
};

const USER_ID_HEADER = 'oai-authenticated-user-id';
const USER_EMAIL_HEADER = 'oai-authenticated-user-email';
const USER_FULL_NAME_HEADER = 'oai-authenticated-user-full-name';
const USER_FULL_NAME_ENCODING_HEADER = 'oai-authenticated-user-full-name-encoding';

async function superAdminExists(): Promise<boolean> {
  const [r] = await getDb().select({ id: accounts.userId }).from(accounts).where(and(eq(accounts.role, 'super_admin'), eq(accounts.status, 'active'))).limit(1);
  return !!r;
}

/**
 * The role used for every request. The stored role wins for super_admin. An ADMIN_EMAILS entry (verified email) grants `admin`
 * only while no active super_admin exists. After that it grants `admin` only when ADMIN_EMAILS_BREAKGLASS=true (break-glass:
 * MFA still applies and every admin request is audited). It never grants super_admin.
 */
export async function effectiveRole(role: string, email: string, verified: boolean): Promise<{ role: Role; breakGlass: boolean }> {
  const stored: Role = role === 'super_admin' || role === 'admin' || role === 'support' ? role : 'customer';
  if (stored === 'super_admin' || !verified || !adminEmails().has(email.toLowerCase())) return { role: stored, breakGlass: false };
  if (!(await superAdminExists())) return { role: 'admin', breakGlass: false };
  if (adminEmailsBreakGlass() && !isAdminRole(stored)) return { role: 'admin', breakGlass: true };
  return { role: stored, breakGlass: false };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Resolves the caller from a Wasl session cookie, then the hosted ChatGPT identity headers.
 * Staff sessions end after STAFF_IDLE_MS without activity or STAFF_ABSOLUTE_MS after sign-in: the row is deleted,
 * `auth.session_expired` is audited and the caller is anonymous. `peek` reads the session without counting as activity.
 * shortcut: the idle clock moves at most once per 60 s (STAFF_TOUCH_MS), so the real idle end can be up to 60 s later than shown.
 */
export async function getPrincipal(request: Request, opts: { peek?: boolean } = {}): Promise<Principal | null> {
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
      const verified = !!row.a.emailVerifiedAt;
      const eff = await effectiveRole(row.a.role, row.a.email, verified);
      let seen = row.s.lastSeenAt;
      let sessionEnds: Principal['sessionEnds'];
      if (isStaffRole(eff.role)) {
        const absoluteEndsAt = row.s.createdAt + STAFF_ABSOLUTE_MS;
        const limit = now >= absoluteEndsAt ? 'absolute' : now >= seen + STAFF_IDLE_MS ? 'idle' : null;
        if (limit) {
          // Only the request that really deletes the row writes the audit row.
          const gone = await db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
          if (gone.length) await audit(request, row.a.userId, 'auth.session_expired', { type: 'account', id: row.a.userId }, { limit }, { actorRole: eff.role });
          return null;
        }
        if (!opts.peek && now - seen >= STAFF_TOUCH_MS) {
          await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
          seen = now;
        }
        sessionEnds = { idleEndsAt: seen + STAFF_IDLE_MS, absoluteEndsAt };
      } else if (now - seen > 10 * 60 * 1000) {
        await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
      }
      return {
        userId: row.a.userId,
        email: row.a.email,
        name: row.a.name || row.a.email,
        role: eff.role,
        breakGlass: eff.breakGlass,
        provider: 'password',
        emailVerified: verified,
        sessionId: id,
        mfaVerifiedAt: row.s.mfaVerifiedAt,
        sessionEnds,
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
      const eff = await effectiveRole(a.role, a.email, true);
      return {
        userId: a.userId,
        email: a.email,
        name: a.name || fullName || a.email,
        role: eff.role,
        breakGlass: eff.breakGlass,
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
  // super_admin passes wherever `admin` is allowed.
  // Audit target = route pattern, not the raw path: a new id in the URL must not make a new throttle key (review N1).
  const path = new URL(request.url).pathname.replace(/^(\/api\/admin\/(?:users|requests|tickets))\/[^/]+/, '$1/:id').slice(0, 120);
  if (!roles.includes(p.role) && !(p.role === 'super_admin' && roles.includes('admin'))) {
    // A signed-in person tried an admin or staff route they may not use. (Not signed in = 401, not written: no actor to record.)
    // One row per actor, route and reason per 60 seconds, so a customer hammering an admin URL cannot flood the log.
    await auditDeniedOnce(request, p.userId, 'auth.admin_denied', { type: 'route', id: path }, 'role_not_allowed', { actorRole: p.role });
    throw new HttpError(403, 'Forbidden', 'forbidden');
  }
  // All staff (support, admin, super_admin) need an MFA-verified session (SEC-3b, ADMIN.md s.51, D-10).
  if (isStaffRole(p.role)) {
    try {
      await assertAdminMfa(p);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'mfa_required') await auditDeniedOnce(request, p.userId, 'auth.admin_denied', { type: 'route', id: path }, 'mfa_required', { actorRole: p.role });
      throw e;
    }
  }
  if (p.breakGlass) await audit(request, p.userId, 'auth.break_glass_used', { type: 'account', id: p.userId }, { method: request.method, path: new URL(request.url).pathname });
  return p;
}

/** Like requireUser, but for the MFA routes: a staff member (support, admin, super_admin) with a real session cookie (hosted ChatGPT identity has none). */
export async function requireAdminSession(request: Request): Promise<Principal & { sessionId: string }> {
  const p = await requireUser(request);
  if (!isStaffRole(p.role) || !p.sessionId) throw new HttpError(403, 'Forbidden', 'forbidden');
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
