export type CatalogModel = {
  id: string; name: string; company: string; description: string; context: number;
  input: number | null; output: number | null; category: 'text' | 'vision' | 'image' | 'audio' | 'video';
  inputModalities: string[]; outputModalities: string[]; parameters: string[];
  pricingExtras: Record<string, number>; created: number | null; free: boolean;
};

/** Shape of one entry in OpenRouter's /api/v1/models response (fields we read). */
type UpstreamModel = {
  id?: unknown; name?: unknown; description?: unknown; context_length?: unknown; created?: unknown;
  pricing?: Record<string, unknown> & { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  supported_parameters?: unknown;
};

export function normalizeModel(raw: unknown): CatalogModel {
  const m = (raw ?? {}) as UpstreamModel;
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  const inputModalities = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
  const outputModalities = Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : [];
  const category = outputModalities.includes('image') ? 'image' : outputModalities.includes('audio') ? 'audio' : inputModalities.includes('video') ? 'video' : inputModalities.includes('image') ? 'vision' : 'text';
  return {
    id: String(m.id), name: String(m.name ?? m.id), company: String(m.id).split('/')[0],
    description: String(m.description ?? '').replace(/\s+/g, ' ').slice(0, 360),
    context: Number(m.context_length) || 0,
    input: Number.isFinite(prompt) && prompt >= 0 ? prompt * 1e6 : null,
    output: Number.isFinite(completion) && completion >= 0 ? completion * 1e6 : null,
    category, inputModalities, outputModalities,
    parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    pricingExtras: Object.fromEntries(Object.entries(m.pricing ?? {}).filter(([k,v]) => k !== 'prompt' && k !== 'completion' && typeof v === 'string').map(([k,v]) => [k, Number(v)])),
    created: Number(m.created) || null, free: prompt === 0 && completion === 0,
  };
}
