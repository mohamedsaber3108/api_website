import { desc, gt, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db';
import { incidents } from '../../db/schema';
import { env } from 'cloudflare:workers';
import { features } from './config';
import { inferenceEnabled } from './flags';

export async function healthReport() {
  let database: 'available' | 'unavailable' = 'unavailable';
  try {
    if (env.DB) {
      await env.DB.prepare('SELECT 1').first();
      database = 'available';
    }
  } catch {
    database = 'unavailable';
  }
  const report = {
    catalog: 'available',
    database,
    api_keys: database,
    inference: (await inferenceEnabled()) ? 'available' : 'not_configured',
    billing: features.billing() ? 'available' : 'not_configured',
    email: features.email() ? 'available' : 'not_configured',
  };
  const status = database === 'available' ? 'ok' : 'degraded';
  return { status, ...report };
}

export async function openIncidents(limit = 10) {
  try {
    return await getDb().select().from(incidents).orderBy(desc(incidents.createdAt)).limit(limit);
  } catch {
    return [];
  }
}

/** Resolved incidents stay on the public status view for 14 days. */
export const RECENT_INCIDENT_MS = 14 * 24 * 3600 * 1000;

export type PublicIncident = {
  id: string;
  title: string;
  body: string;
  status: string;
  severity: string;
  /** When the incident started (epoch ms). */
  createdAt: number;
  resolvedAt: number | null;
  open: boolean;
};

/** Open incidents plus incidents resolved in the last 14 days. Empty when the database cannot be read. */
export async function publicIncidents(now = Date.now(), limit = 20): Promise<PublicIncident[]> {
  try {
    const rows = await getDb()
      .select()
      .from(incidents)
      .where(or(isNull(incidents.resolvedAt), gt(incidents.resolvedAt, now - RECENT_INCIDENT_MS)))
      .orderBy(desc(incidents.createdAt))
      .limit(limit);
    return rows.map(r => ({ id: r.id, title: r.title, body: r.body, status: r.status, severity: r.severity, createdAt: r.createdAt, resolvedAt: r.resolvedAt, open: r.resolvedAt == null }));
  } catch {
    return [];
  }
}

/**
 * Public status view (NOT-1). Booleans and fixed words only: no key values, no host names, no error text.
 * `degraded` when the database is down or a major/critical incident is open.
 * `health` and `incidents` keep the shape older clients read.
 */
export async function statusReport(now = Date.now()) {
  const health = await healthReport();
  const incidentRows = health.database === 'available' ? await publicIncidents(now) : [];
  const databaseUp = health.database === 'available';
  const seriousOpen = incidentRows.some(i => i.open && (i.severity === 'major' || i.severity === 'critical'));
  return {
    status: databaseUp && !seriousOpen ? ('operational' as const) : ('degraded' as const),
    checkedAt: new Date(now).toISOString(),
    checks: {
      database: databaseUp ? ('ok' as const) : ('down' as const),
      inference: health.inference === 'available' ? ('on' as const) : ('off' as const),
      billing: health.billing === 'available' ? ('configured' as const) : ('not_configured' as const),
      email: health.email === 'available' ? ('configured' as const) : ('not_configured' as const),
    },
    health,
    incidents: incidentRows,
  };
}
