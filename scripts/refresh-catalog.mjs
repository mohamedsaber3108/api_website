import fs from 'node:fs/promises';

const url = 'https://openrouter.ai/api/v1/models';
const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
const body = await response.json();
if (!Array.isArray(body.data) || body.data.length < 100) throw new Error('Catalog response missing models');
const normalized = body.data.map((m) => {
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  const inputModalities = m.architecture?.input_modalities ?? [];
  const outputModalities = m.architecture?.output_modalities ?? [];
  const category = outputModalities.includes('image') ? 'image' : outputModalities.includes('audio') ? 'audio' : inputModalities.includes('video') ? 'video' : inputModalities.includes('image') ? 'vision' : 'text';
  return {
    id: m.id,
    name: m.name,
    company: m.id.split('/')[0],
    description: String(m.description ?? '').replace(/\s+/g, ' ').slice(0, 360),
    context: Number(m.context_length) || 0,
    input: Number.isFinite(prompt) && prompt >= 0 ? prompt * 1e6 : null,
    output: Number.isFinite(completion) && completion >= 0 ? completion * 1e6 : null,
    category,
    inputModalities,
    outputModalities,
    parameters: m.supported_parameters ?? [],
    pricingExtras: Object.fromEntries(Object.entries(m.pricing ?? {}).filter(([k,v]) => k !== 'prompt' && k !== 'completion' && typeof v === 'string').map(([k,v])=>[k, Number(v)])),
    created: m.created ?? null,
    free: prompt === 0 && completion === 0,
  };
});
const stamp = new Date().toISOString();
await fs.writeFile('data/catalog-snapshot.json', JSON.stringify({ source: url, updatedAt: stamp, count: normalized.length, models: normalized }));
console.log(`Saved ${normalized.length} models at ${stamp}`);
