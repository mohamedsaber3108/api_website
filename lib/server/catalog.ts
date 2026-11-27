import snapshot from '../../data/catalog-snapshot.json';
import { normalizeModel, type CatalogModel } from '../catalog';
import { providerBaseUrl } from './config';

export type CatalogResult = { source: string; updatedAt: string; count: number; models: CatalogModel[]; live: boolean };

let cache: { at: number; value: CatalogResult } | null = null;

/** Live OpenRouter catalog (cached 1h in the isolate) with the bundled snapshot as fallback. */
export async function loadCatalog(): Promise<CatalogResult> {
  if (cache && Date.now() - cache.at < 3_600_000) return cache.value;
  try {
    const response = await fetch(`${providerBaseUrl()}/models`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    const result = (await response.json()) as { data?: unknown[] };
    if (!Array.isArray(result.data) || result.data.length < 100) throw new Error('Catalog incomplete');
    const value: CatalogResult = { source: 'https://openrouter.ai/api/v1/models', updatedAt: new Date().toISOString(), count: result.data.length, models: result.data.map(normalizeModel), live: true };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return { ...(snapshot as unknown as CatalogResult), live: false };
  }
}

export async function findModel(id: string): Promise<CatalogModel | null> {
  return (await loadCatalog()).models.find(m => m.id === id) ?? null;
}
