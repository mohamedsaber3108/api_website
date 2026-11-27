import { getPrincipal, publicUser } from '../../../../lib/server/auth';
import { features } from '../../../../lib/server/config';
import { inferenceEnabled } from '../../../../lib/server/flags';
import { handle, json } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/** Always 200. `user` is null for anonymous callers so the UI can boot without a 401. */
export const GET = handle(async request => {
  const p = await getPrincipal(request);
  return json({
    user: p ? publicUser(p) : null,
    features: { inference: await inferenceEnabled(), billing: features.billing(), email: features.email(), chatgpt: features.chatgptIdentity() },
  });
});
