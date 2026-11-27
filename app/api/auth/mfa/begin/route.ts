import { requireAdminSession } from '../../../../../lib/server/auth';
import { handle, json, requireSameOrigin } from '../../../../../lib/server/http';
import { beginEnrolment } from '../../../../../lib/server/mfa';

export const dynamic = 'force-dynamic';

/** Starts enrolment: returns the text secret and an otpauth link (no QR library; the user can paste either). */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireAdminSession(request);
  return json(await beginEnrolment(request, p.userId, p.email));
});
