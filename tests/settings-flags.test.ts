import { eq, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as requestById from '../app/api/admin/requests/[id]/route';
import * as settings from '../app/api/admin/settings/route';
import * as checkout from '../app/api/billing/checkout/route';
import { getDb } from '../db';
import { accounts, adminRequests, auditLogs, featureFlags } from '../db/schema';
import { GatewayError, newChatContext, parseChatRequest, runChat } from '../lib/server/gateway';
import { flagEnabled, inferenceEnabled, resetFlagCache } from '../lib/server/flags';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(async () => {
  await getDb().update(accounts).set({ role: 'customer' }).where(inArray(accounts.role, ['admin', 'super_admin']));
  await getDb().delete(featureFlags);
  resetFlagCache();
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
});
afterEach(() => { for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete (env as Record<string, unknown>)[k]; });

const idp = (id: string) => ({ params: Promise.resolve({ id }) });
const admin = () => makeUser({ role: 'admin' });
const setFlagVia = (cookie: string, enabled: boolean, reason = 'incident drill') => settings.POST(req('/api/admin/settings', { method: 'POST', cookie, body: { flag: 'inference', enabled, reason } }), idp('x'));
const decide = (cookie: string, id: string, action: 'approve' | 'reject' = 'approve') => requestById.POST(req(`/api/admin/requests/${id}`, { method: 'POST', cookie, body: { action, reason: 'checked it' } }), idp(id));
const audits = (action: string) => getDb().select().from(auditLogs).where(eq(auditLogs.action, action));

describe('inference flag', () => {
  it('effective value needs the env switch, the provider key and a DB flag that is not off', async () => {
    expect(await inferenceEnabled()).toBe(true); // no row means not off
    delete (env as Record<string, unknown>).OPENROUTER_API_KEY;
    expect(await inferenceEnabled()).toBe(false);
    env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
    env.INFERENCE_ENABLED = 'false';
    expect(await inferenceEnabled()).toBe(false);
  });

  it('switching off is immediate for any single admin and is audited', async () => {
    const a = await admin(); // the only admin: no second person is needed to stop
    const res = await setFlagVia(a.cookie, false);
    expect(res.status).toBe(200);
    expect(await inferenceEnabled()).toBe(false);
    const rows = (await audits('admin.flag_changed')).filter(r => r.actorId === a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'feature_flag', targetId: 'inference', result: 'success', actorRole: 'admin', reason: 'incident drill' });
    expect(JSON.parse(rows[0].after as string)).toEqual({ enabled: false });
  });

  it('switching on needs a second approver: the request changes nothing until another admin approves', async () => {
    const a = await admin();
    const b = await admin();
    await setFlagVia(a.cookie, false);
    const res = await setFlagVia(a.cookie, true);
    expect(res.status).toBe(202);
    const { requestId } = await res.json();
    expect(await inferenceEnabled()).toBe(false);
    expect(await (await decide(b.cookie, requestId)).json()).toMatchObject({ status: 'approved', duplicate: false });
    expect(await inferenceEnabled()).toBe(true);
    expect((await getDb().select().from(adminRequests).where(eq(adminRequests.id, requestId)))[0]).toMatchObject({ kind: 'flag_change', requestedBy: a.userId, decidedBy: b.userId });
    expect(await audits('admin.request_created')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: a.userId })]));
    expect(await audits('admin.request_approved')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: b.userId })]));
    expect((await audits('admin.flag_changed')).filter(r => r.actorId === b.userId && JSON.parse(r.after as string).enabled === true)).toHaveLength(1);
  });

  it('the requester cannot approve their own request (403 self_approval) and the flag stays off', async () => {
    const a = await admin();
    await admin();
    await setFlagVia(a.cookie, false);
    const { requestId } = await (await setFlagVia(a.cookie, true)).json();
    const own = await decide(a.cookie, requestId);
    expect(own.status).toBe(403);
    expect((await own.json()).code).toBe('self_approval');
    expect(await inferenceEnabled()).toBe(false);
  });

  it('a second request while one is pending returns the same request; with one admin only it is blocked', async () => {
    const a = await admin();
    const only = await setFlagVia(a.cookie, false).then(() => setFlagVia(a.cookie, true));
    expect(only.status).toBe(409);
    expect((await only.json()).code).toBe('no_second_approver');
    await admin();
    const first = await (await setFlagVia(a.cookie, true)).json();
    const again = await (await setFlagVia(a.cookie, true)).json();
    expect(again).toMatchObject({ requestId: first.requestId, duplicate: true });
  });

  it('a customer and support cannot read or change the flag', async () => {
    for (const who of [await makeUser(), await makeUser({ role: 'support' })]) {
      expect((await setFlagVia(who.cookie, false)).status).toBe(403);
      expect((await settings.GET(req('/api/admin/settings', { cookie: who.cookie }), idp('x'))).status).toBe(403);
    }
    expect(await inferenceEnabled()).toBe(true);
  });

  it('GET shows booleans only, never the key value', async () => {
    const a = await admin();
    const res = await settings.GET(req('/api/admin/settings', { cookie: a.cookie }), idp('x'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-or-not-a-real-key');
    expect(JSON.parse(text).flags[0]).toMatchObject({ key: 'inference', envOn: true, keyPresent: true, dbEnabled: true, effective: true });
  });

  it('read failure means off', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = env.DB;
    try {
      resetFlagCache();
      (env as Record<string, unknown>).DB = undefined;
      expect(await flagEnabled('inference')).toBe(false);
      expect(await inferenceEnabled()).toBe(false);
    } finally { env.DB = saved; spy.mockRestore(); resetFlagCache(); }
    expect(await inferenceEnabled()).toBe(true);
  });

  it('checkout and the gateway both see the flag', async () => {
    env.STRIPE_SECRET_KEY = 'sk_test_not_real';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_not_real';
    const a = await admin();
    await setFlagVia(a.cookie, false);
    const buyer = await makeUser();
    const res = await checkout.POST(req('/api/billing/checkout', { method: 'POST', cookie: buyer.cookie, body: { amountUsd: 5 } }), idp('x'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('inference_not_enabled');
    const run = runChat(newChatContext(buyer.userId, null, 'api'), parseChatRequest({ model: 'minimax/minimax-m3.1-flash', messages: [{ role: 'user', content: 'hi' }] }));
    await expect(run).rejects.toBeInstanceOf(GatewayError);
    await expect(run).rejects.toMatchObject({ status: 503, code: 'service_not_activated' });
  });
});
