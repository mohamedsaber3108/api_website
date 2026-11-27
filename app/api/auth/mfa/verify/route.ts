import { z } from 'zod';
import { requireAdminSession } from '../../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';
import { verifyStepUp } from '../../../../../lib/server/mfa';

export const dynamic = 'force-dynamic';

/** Step-up: a TOTP code or a recovery code marks this session as MFA verified. */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireAdminSession(request);
  const { code } = await parseBody(request, z.object({ code: z.string().trim().min(6).max(20) }));
  return json(await verifyStepUp(request, p, code));
});
