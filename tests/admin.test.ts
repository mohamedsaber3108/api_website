import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as audit from '../app/api/admin/audit/route';
import * as incidents from '../app/api/admin/incidents/route';
import * as models from '../app/api/admin/models/route';
import * as overview from '../app/api/admin/overview/route';
import * as ticketById from '../app/api/admin/tickets/[id]/route';
import * as tickets from '../app/api/admin/tickets/route';
import * as requestById from '../app/api/admin/requests/[id]/route';
import * as requests from '../app/api/admin/requests/route';
import * as usage from '../app/api/admin/usage/route';
import * as credits from '../app/api/admin/users/[id]/credits/route';
import * as userById from '../app/api/admin/users/[id]/route';
import * as users from '../app/api/admin/users/route';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
// [method, path, handler, roles allowed]. 17 handlers in 12 route files under app/api/admin.
const ROUTES: Array<[string, string, Handler, 'super' | 'admin' | 'staff']> = [
  ['GET', '/api/admin/audit', audit.GET as Handler, 'super'],
  ['GET', '/api/admin/incidents', incidents.GET as Handler, 'staff'],
  ['POST', '/api/admin/incidents', incidents.POST as Handler, 'admin'],
  ['PATCH', '/api/admin/incidents', incidents.PATCH as Handler, 'admin'],
  ['GET', '/api/admin/models', models.GET as Handler, 'admin'],
  ['PUT', '/api/admin/models', models.PUT as Handler, 'admin'],
  ['GET', '/api/admin/overview', overview.GET as Handler, 'staff'],
  ['GET', '/api/admin/tickets', tickets.GET as Handler, 'staff'],
  ['GET', '/api/admin/tickets/t1', ticketById.GET as Handler, 'staff'],
  ['PATCH', '/api/admin/tickets/t1', ticketById.PATCH as Handler, 'staff'],
  ['POST', '/api/admin/tickets/t1', ticketById.POST as Handler, 'staff'],
  ['GET', '/api/admin/usage', usage.GET as Handler, 'admin'],
  ['GET', '/api/admin/users', users.GET as Handler, 'admin'],
  ['PATCH', '/api/admin/users/u1', userById.PATCH as Handler, 'admin'],
  ['POST', '/api/admin/users/u1/credits', credits.POST as Handler, 'admin'],
  ['GET', '/api/admin/requests', requests.GET as Handler, 'admin'],
  ['POST', '/api/admin/requests/r1', requestById.POST as Handler, 'admin'],
];

const call = (method: string, path: string, fn: Handler, cookie?: string, origin = true) =>
  fn(req(path, { method, cookie, origin, body: method === 'GET' ? undefined : {} }), { params: Promise.resolve({ id: path.split('/')[4] ?? 'x' }) });

describe('admin routes: 17 handlers', () => {
  it('lists 17 handlers', () => { expect(ROUTES).toHaveLength(17); });

  describe.each(ROUTES)('%s %s', (method, path, fn, who) => {
    it('no session -> 401 sign_in_required', async () => {
      const res = await call(method, path, fn);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('sign_in_required');
    });
    it('a customer -> 403 forbidden', async () => {
      const c = await makeUser({ role: 'customer' });
      const res = await call(method, path, fn, c.cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('forbidden');
    });
    it('an expired session -> 401', async () => {
      const a = await makeUser({ role: 'admin', expiresAt: Date.now() - 1000 });
      expect((await call(method, path, fn, a.cookie)).status).toBe(401);
    });
    if (who !== 'staff') {
      it('support staff (not admin) -> 403 forbidden', async () => {
        const s = await makeUser({ role: 'support' });
        expect((await call(method, path, fn, s.cookie)).status).toBe(403);
      });
    }
    if (who === 'super') {
      it('an admin (not super_admin) -> 403 forbidden', async () => {
        const a = await makeUser({ role: 'admin' });
        const res = await call(method, path, fn, a.cookie);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('forbidden');
      });
    }
    if (method !== 'GET') {
      it('a foreign or missing Origin -> 403 invalid_origin before any auth work', async () => {
        const res = await call(method, path, fn, undefined, false);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('invalid_origin');
      });
    }
  });

  it('positive control: an admin passes the auth gate on a read route', async () => {
    const a = await makeUser({ role: 'admin' });
    expect((await call('GET', '/api/admin/overview', overview.GET as Handler, a.cookie)).status).toBe(200);
    expect((await call('GET', '/api/admin/users', users.GET as Handler, a.cookie)).status).toBe(200);
  });
  it('positive control: a super_admin passes the gate on the audit route', async () => {
    const s = await makeUser({ role: 'super_admin' });
    expect((await call('GET', '/api/admin/audit', audit.GET as Handler, s.cookie)).status).toBe(200);
  });
  it('positive control: support passes the gate on staff routes', async () => {
    const s = await makeUser({ role: 'support' });
    expect((await call('GET', '/api/admin/tickets', tickets.GET as Handler, s.cookie)).status).toBe(200);
  });
});

describe('admin credit adjustment (SEC-2: a request, applied by a second admin; see approvals.test.ts)', () => {
  it('only creates a pending request, once per requestKey; no money moves yet', async () => {
    const a = await makeUser({ role: 'admin' });
    await makeUser({ role: 'admin' }); // a second admin exists, so the request is accepted
    const target = await makeUser();
    const run = () => credits.POST(req(`/api/admin/users/${target.userId}/credits`, { method: 'POST', cookie: a.cookie, body: { amountUsd: 5, note: 'goodwill credit', requestKey: 'k1' } }), { params: Promise.resolve({ id: target.userId }) });
    const first = await run();
    expect(first.status).toBe(202);
    const f = await first.json();
    expect(f).toMatchObject({ ok: true, pending: true, duplicate: false });
    const second = await run();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true, requestId: f.requestId });
    expect(await getBalanceMicroUsd(target.userId)).toBe(0);
  });
  it('404 for an unknown user, 400 for zero amount', async () => {
    const a = await makeUser({ role: 'admin' });
    const p = (id: string, amountUsd: number) => credits.POST(req(`/api/admin/users/${id}/credits`, { method: 'POST', cookie: a.cookie, body: { amountUsd, note: 'testing note' } }), { params: Promise.resolve({ id }) });
    expect((await p('nobody', 5)).status).toBe(404);
    expect((await p('nobody', 0)).status).toBe(400);
  });
});
