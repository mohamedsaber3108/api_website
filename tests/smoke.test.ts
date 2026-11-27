import { afterAll, beforeAll, expect, it } from 'vitest';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
it('db works', async () => { expect(await getBalanceMicroUsd('nobody')).toBe(0); });
