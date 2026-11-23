import { desc } from 'drizzle-orm';
import { getDb } from '../../db';
import { incidents } from '../../db/schema';
import { env } from 'cloudflare:workers';
import { features } from './config';

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
    inference: features.inference() ? 'available' : 'not_configured',
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
