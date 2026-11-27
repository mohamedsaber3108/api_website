import { requireRole } from '../../../../lib/server/auth';
import { listRequests } from '../../../../lib/server/approvals';
import { handle, json } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/** Requests waiting for a second approver (default), or `?status=approved|rejected|expired|all`. */
export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  const allowed = ['pending', 'approved', 'rejected', 'expired', 'all'];
  return json({ requests: await listRequests(allowed.includes(status) ? status : 'pending') });
});
