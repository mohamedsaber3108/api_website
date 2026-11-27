import { requireAdminSession } from '../../../../../lib/server/auth';
import { handle, json } from '../../../../../lib/server/http';
import { assertRecentMfa, getMfaState } from '../../../../../lib/server/mfa';

export const dynamic = 'force-dynamic';

/** Where this admin session stands: enrolled, verified, and verified recently enough for credit changes. */
export const GET = handle(async request => {
  const p = await requireAdminSession(request);
  const state = await getMfaState(p.userId);
  let recent = true;
  try { assertRecentMfa(p); } catch { recent = false; }
  return json({ ...state, verified: !!p.mfaVerifiedAt, recent });
});
