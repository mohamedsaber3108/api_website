import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { creditHolds, creditLedger, usageEvents } from '../db/schema';
import { newChatContext, parseChatRequest, runChat } from '../lib/server/gateway';
import { addLedgerEntry, getAvailableMicroUsd, getBalanceMicroUsd } from '../lib/server/ledger';
import { makeUser, startDb } from './helpers/db';

// SEC-1 and GW-1. Provider stubbed, no network. Snapshot prices: input 0.15, output 0.6 micro-USD per token.
// The request below has a worst-case cost (hold) of 75 micro-USD: input 12 tokens, 100 output tokens, 20% markup.
const MODEL = 'minimax/minimax-m3.1-flash';
const HOLD = 75;
let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'PUBLIC_BASE_URL']) delete (env as Record<string, unknown>)[k]; });

const body = (extra: object = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, ...extra });
const isChat = (url: unknown) => String(url).startsWith('https://openrouter.ai/api/v1/chat/completions');
const okReply = (cost = 0.00001) => Response.json({ id: 'g', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 2, cost } });
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A stream that sends the given text chunks and then fails, like a dropped connection. */
function cutStream(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.error(new Error('connection lost')); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function funded(micro: number) {
  const u = await makeUser();
  await addLedgerEntry({ userId: u.userId, deltaMicroUsd: micro, type: 'topup', idempotencyKey: `fund:${u.userId}` });
  return u;
}
const holds = (userId: string) => getDb().select().from(creditHolds).where(eq(creditHolds.userId, userId));
const usage = (userId: string) => getDb().select().from(usageEvents).where(eq(usageEvents.userId, userId));
const ledger = (userId: string) => getDb().select().from(creditLedger).where(eq(creditLedger.userId, userId));
const call = (userId: string, extra: object = {}) => runChat(newChatContext(userId, null, 'api'), parseChatRequest(body(extra)));

/** Holds the provider until `release()`, so all parallel calls compete for the balance while none has settled. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(r => { open = r; });
  return { opened, release: open };
}
const until = async (cond: () => boolean) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise(r => setTimeout(r, 10)); expect(cond()).toBe(true); };

describe('SEC-1: reserve credit before the provider call', () => {
  it('balance covers 3 calls, 20 in parallel: exactly 3 succeed, 17 get 402, ledger never negative and exact', async () => {
    const u = await funded(3 * HOLD);
    const g = gate();
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); await g.opened; return okReply(); });
    const results: Array<number | 'ok'> = [];
    const all = Array.from({ length: 20 }, () => call(u.userId).then(async r => { await r.json(); results.push('ok'); }, e => { results.push(e.status); }));
    await until(() => results.filter(r => r === 402).length === 17); // 17 refused while the other 3 are still in flight
    expect(await getAvailableMicroUsd(u.userId)).toBe(0);
    g.release();
    await Promise.all(all);
    expect(results.filter(r => r === 'ok')).toHaveLength(3);
    expect(results.filter(r => r === 402)).toHaveLength(17);
    expect(fetchSpy.mock.calls.filter(c => isChat(c[0]))).toHaveLength(3); // refused calls never reached the provider
    const rows = await ledger(u.userId);
    const charges = rows.filter(r => r.type === 'usage').reduce((s, r) => s + r.deltaMicroUsd, 0);
    const topups = rows.filter(r => r.type === 'topup').reduce((s, r) => s + r.deltaMicroUsd, 0);
    expect(rows.filter(r => r.type === 'usage')).toHaveLength(3);
    const balance = await getBalanceMicroUsd(u.userId);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(topups + charges); // charges are negative
    expect(await getAvailableMicroUsd(u.userId)).toBe(balance); // every hold closed
    expect((await holds(u.userId)).every(x => x.status === 'settled')).toBe(true);
  });

  it('20 parallel streams cut halfway: 3 run, 17 get 402, usage rows are aborted, charge follows the rule, holds closed', async () => {
    const u = await funded(3 * HOLD);
    const g = gate();
    // No usage chunk before the cut: the charge is the input estimate (12 tokens) plus what was delivered ("hello" = 2 tokens): round(1.8 + 1.2) = 3 -> 4 with markup.
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); await g.opened; return cutStream([sse({ choices: [{ delta: { content: 'hello' } }] })]); });
    const results: Array<number | 'cut'> = [];
    const all = Array.from({ length: 20 }, () => call(u.userId, { stream: true }).then(async r => {
      const reader = r.body!.getReader();
      await (async () => { for (;;) { const x = await reader.read(); if (x.done) return; } })().catch(() => {});
      results.push('cut');
    }, e => { results.push(e.status); }));
    await until(() => results.filter(r => r === 402).length === 17);
    g.release();
    await Promise.all(all);
    expect(results.filter(r => r === 'cut')).toHaveLength(3);
    const events = await usage(u.userId);
    expect(events).toHaveLength(3);
    for (const e of events) expect(e).toMatchObject({ status: 'aborted', costMicroUsd: 4, outputTokens: 2, inputTokens: 12 });
    expect(await getBalanceMicroUsd(u.userId)).toBe(3 * HOLD - 12);
    expect(await getAvailableMicroUsd(u.userId)).toBe(3 * HOLD - 12); // holds released
    expect((await holds(u.userId)).filter(x => x.status === 'open')).toHaveLength(0);
  });

  it('a stream cut after the provider sent usage is charged from that usage, and keeps status aborted', async () => {
    const u = await funded(HOLD);
    fetchSpy.mockImplementation(async (url: string) => {
      if (!isChat(url)) throw new Error('no network');
      return cutStream([sse({ choices: [{ delta: { content: 'hi' } }] }), sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 40, cost: 0.00005 } })]);
    });
    const r = await call(u.userId, { stream: true });
    await r.text().catch(() => {});
    const [e] = await usage(u.userId);
    expect(e).toMatchObject({ status: 'aborted', providerCostMicroUsd: 50, costMicroUsd: 60 }); // 50 micro at 20%
    expect(await getBalanceMicroUsd(u.userId)).toBe(HOLD - 60);
  });

  it('a client that cancels the stream is charged for what was delivered and the hold is closed', async () => {
    const u = await funded(HOLD);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'abc' } }] }))); } })); });
    const r = await call(u.userId, { stream: true });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    await until(() => true);
    const [e] = await usage(u.userId);
    expect(e.status).toBe('aborted');
    expect((await holds(u.userId)).filter(x => x.status === 'open')).toHaveLength(0);
  });

  it('the charge never exceeds the hold: a provider cost above the worst case cannot take the balance below zero', async () => {
    const u = await funded(HOLD);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return okReply(5); }); // $5 reported by the provider
    const r = await call(u.userId);
    expect((await r.json()).wasl.charged_usd).toBeCloseTo(HOLD / 1e6, 9);
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
    const [e] = await usage(u.userId);
    expect(e.providerCostMicroUsd).toBe(5_000_000); // our real cost stays on record
  });

  it('a failed upstream call (HTTP 500) releases the hold and charges nothing', async () => {
    const u = await funded(HOLD);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return Response.json({ error: { message: 'x' } }, { status: 500 }); });
    await expect(call(u.userId)).rejects.toMatchObject({ status: 502 });
    expect((await holds(u.userId)).map(x => x.status)).toEqual(['released']);
    expect(await getAvailableMicroUsd(u.userId)).toBe(HOLD);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return okReply(); });
    await expect(call(u.userId)).resolves.toBeInstanceOf(Response); // the credit is usable again
  });

  it('an unreachable provider releases the hold', async () => {
    const u = await funded(HOLD);
    fetchSpy.mockImplementation(async () => { throw new Error('offline'); });
    await expect(call(u.userId)).rejects.toMatchObject({ status: 502, code: 'upstream_unreachable' });
    expect(await getAvailableMicroUsd(u.userId)).toBe(HOLD);
  });

  it('an open hold blocks credit; an expired hold frees it', async () => {
    const u = await funded(HOLD + 10);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return okReply(); });
    const now = Date.now();
    await getDb().insert(creditHolds).values({ id: 'h-live', userId: u.userId, requestId: `old-live-${u.userId}`, amountMicroUsd: HOLD, status: 'open', createdAt: now, expiresAt: now + 60_000 });
    await expect(call(u.userId)).rejects.toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect(await getAvailableMicroUsd(u.userId)).toBe(10);
    await getDb().update(creditHolds).set({ expiresAt: now - 1 }).where(eq(creditHolds.id, 'h-live')); // the crashed call's hold runs out
    expect(await getAvailableMicroUsd(u.userId)).toBe(HOLD + 10);
    await expect(call(u.userId)).resolves.toBeInstanceOf(Response);
  });

  it('replay: the same request id charges once and keeps one hold row', async () => {
    const u = await funded(2 * HOLD);
    fetchSpy.mockImplementation(async (url: string) => { if (!isChat(url)) throw new Error('no network'); return okReply(); });
    const ctx = newChatContext(u.userId, null, 'api');
    await runChat(ctx, parseChatRequest(body()));
    const after = await getBalanceMicroUsd(u.userId);
    await runChat(ctx, parseChatRequest(body()));
    expect(await getBalanceMicroUsd(u.userId)).toBe(after);
    expect((await holds(u.userId))).toHaveLength(1);
    expect((await usage(u.userId))).toHaveLength(1);
  });

  it('402 says in plain English and Arabic that the balance is too low, and links to add credit', async () => {
    env.PUBLIC_BASE_URL = 'https://wasl.example/';
    const u = await funded(10);
    const err = await call(u.userId).catch(e => e);
    expect(err).toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect(err.message).toContain('Your balance is too low');
    expect(err.message).toContain('رصيدك غير كافٍ');
    expect(err.message.match(/https:\/\/wasl\.example\/dashboard/g)).toHaveLength(2);
    expect(fetchSpy.mock.calls.some(c => isChat(c[0]))).toBe(false);
  });

  it('a user with no credit cannot start a call, and nothing is held', async () => {
    const u = await makeUser();
    await expect(call(u.userId)).rejects.toMatchObject({ status: 402 });
    expect(await holds(u.userId)).toHaveLength(0);
  });
});
