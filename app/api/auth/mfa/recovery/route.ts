import { z } from 'zod';
import { requireAdminSession } from '../../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';
import { regenerateRecovery } from '../../../../../lib/server/mfa';

export const dynamic = 'force-dynamic';

/** Replaces the recovery codes. Needs a valid current TOTP code (a recovery code is not accepted here). */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireAdminSession(request);
  const { code } = await parseBody(request, z.object({ code: z.string().trim().min(6).max(6) }));
  return json(await regenerateRecovery(request, p, code));
});
