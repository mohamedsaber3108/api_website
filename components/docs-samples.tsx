'use client';
import { useEffect, useState } from 'react';
import { ENDPOINT_IDS, ENDPOINTS, ERROR_CODES, ONBOARDING, SAMPLE_LANGS, sample, type EndpointId, type SampleLang } from '../lib/docs-samples';

type Lang = 'ar' | 'en';
const LANG_LABEL: Record<SampleLang, string> = { curl: 'cURL', js: 'JavaScript', python: 'Python' };
const STORE = 'wasl-onboarding';

/** FEAT-1: first-call checklist. Ticks stay in this browser only. Inline code is isolated (dir="ltr") so it does not reorder inside Arabic text. */
export function OnboardingChecklist({ lang }: { lang: Lang }) {
  const ar = lang === 'ar';
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || '[]');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(v)) setDone(v.filter((x): x is string => typeof x === 'string'));
    } catch { /* ignore a broken value */ }
  }, []);
  const toggle = (id: string) => {
    const next = done.includes(id) ? done.filter(x => x !== id) : [...done, id];
    setDone(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* storage blocked: ticks last for this visit */ }
  };
  return <div className="docs-live" id="onboarding">
    <div className="docs-live-head"><strong>{ar ? 'قائمة البدء' : 'Getting started checklist'}</strong><span><bdi>{done.length}/{ONBOARDING.length}</bdi></span></div>
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
      {ONBOARDING.map(s => <li key={s.id}><label style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <input type="checkbox" checked={done.includes(s.id)} onChange={() => toggle(s.id)} />
        <span>{ar ? s.ar : s.en}{s.codes?.map(c => <span key={c}>{' '}<code dir="ltr">{c}</code></span>)}{(ar ? s.arTail : s.enTail) ? ` ${ar ? s.arTail : s.enTail}` : ''}</span>
      </label></li>)}
    </ol>
  </div>;
}

/** FEAT-1: cURL, JavaScript and Python samples for chat, stream, balance, usage and models. The key is always the placeholder. */
export function DocsSamples({ lang, origin }: { lang: Lang; origin: string }) {
  const ar = lang === 'ar';
  const [id, setId] = useState<EndpointId>('chat');
  const [sl, setSl] = useState<SampleLang>('curl');
  const [copied, setCopied] = useState(false);
  const text = sample(id, sl, origin);
  const e = ENDPOINTS[id];
  const copy = () => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); };
  return <div className="docs-live" id="samples">
    <div className="docs-live-head"><strong>{ar ? 'أمثلة جاهزة للنسخ' : 'Copy-ready samples'}</strong><span>{ar ? 'المفتاح مثال فقط' : 'Placeholder key'}</span></div>
    <div role="group" aria-label={ar ? 'نقطة النهاية' : 'Endpoint'} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {ENDPOINT_IDS.map(x => <button key={x} type="button" className="pill-link" aria-pressed={x === id} onClick={() => setId(x)}>{ar ? ENDPOINTS[x].ar : ENDPOINTS[x].en}</button>)}
    </div>
    <div role="group" aria-label={ar ? 'اللغة' : 'Language'} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {SAMPLE_LANGS.map(x => <button key={x} type="button" className="pill-link" aria-pressed={x === sl} onClick={() => setSl(x)}><bdi>{LANG_LABEL[x]}</bdi></button>)}
    </div>
    <p><code dir="ltr">{e.method} /api/v1{e.path}</code>{e.scope ? <>{' '}{ar ? 'تتطلب صلاحية' : 'needs the scope'} <code dir="ltr">{e.scope}</code></> : null}</p>
    <div className="code-block"><div className="code-block-head"><span><span /> <bdi>{LANG_LABEL[sl]}</bdi></span><button type="button" onClick={copy}>{ar ? (copied ? 'تم النسخ' : 'نسخ') : (copied ? 'Copied' : 'Copy')}</button></div><pre dir="ltr"><code>{text}</code></pre></div>
  </div>;
}

/** FEAT-1: every error code the gateway can return, in the page language. Generated from ERROR_CODES. */
export function ErrorCodes({ lang }: { lang: Lang }) {
  const ar = lang === 'ar';
  return <div id="errors">
    <p>{ar ? 'شكل الخطأ:' : 'Error shape:'} <code dir="ltr">{'{"error":{"message","type","code"}}'}</code>. {ar ? 'واجهة النماذج العامة تعيد' : 'The public models endpoint returns'} <code dir="ltr">{'{"error","code","retry_after"}'}</code>.</p>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <caption style={{ textAlign: 'start' }}>{ar ? 'رموز الأخطاء' : 'Error codes'}</caption>
      <thead><tr><th scope="col" style={{ textAlign: 'start' }}>HTTP</th><th scope="col" style={{ textAlign: 'start' }}>code</th><th scope="col" style={{ textAlign: 'start' }}>{ar ? 'المعنى' : 'Meaning'}</th></tr></thead>
      <tbody>{ERROR_CODES.map(c => <tr key={`${c.status}-${c.code}`}><td><bdi>{c.status}</bdi></td><td><code dir="ltr">{c.code}</code></td><td>{ar ? c.ar : c.en}</td></tr>)}</tbody>
    </table>
  </div>;
}
