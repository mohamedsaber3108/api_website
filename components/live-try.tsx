'use client';
import { useState } from 'react';
import { ArrowUpRight, Eye, EyeOff, Send, ShieldCheck, Wallet } from 'lucide-react';
import type { CatalogModel } from '../lib/catalog';
import { rateLimitedText, type SessionInfo } from '../lib/client-api';
type Props = { lang: 'ar' | 'en'; models: CatalogModel[]; selected: CatalogModel; session: SessionInfo | null; onSignIn: () => void };
type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
type ChatReply = { error?: { message?: string }; choices?: { message?: { content?: unknown } }[]; usage?: Usage; wasl?: { charged_usd?: number } };
type TryReply = { error?: string; answer?: string; usage?: Usage };

export default function LiveTry({ lang, models, selected, session, onSignIn }: Props) {
  const ar = lang === 'ar';
  const creditsAvailable = !!session?.user && !!session.features.inference;
  const [mode, setMode] = useState<'credits' | 'byok'>(creditsAvailable ? 'credits' : 'byok');
  const activeMode = mode === 'credits' && !creditsAvailable ? 'byok' : mode;
  const [key, setKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [model, setModel] = useState(selected.id);
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage>(null);
  const [charged, setCharged] = useState<number | null>(null);
  const textModels = models.filter(m => m.outputModalities.includes('text') && m.inputModalities.includes('text') && !m.id.includes(':batch'));
  const chosen = textModels.some(m => m.id === model) ? model : textModels[0]?.id;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setAnswer(''); setUsage(null); setCharged(null);
    try {
      if (activeMode === 'credits') {
        const r = await fetch('/api/account/playground', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: chosen, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }) });
        const j = (await r.json()) as ChatReply;
        if (r.status === 429 && r.headers.has('retry-after')) throw new Error(rateLimitedText(Number(r.headers.get('retry-after')), lang));
        if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        const content = j?.choices?.[0]?.message?.content;
        setAnswer(typeof content === 'string' && content ? content : ar ? 'النموذج لم يُرجع نصًا.' : 'The model returned no text.');
        setUsage(j.usage ?? null);
        setCharged(typeof j?.wasl?.charged_usd === 'number' ? j.wasl.charged_usd : null);
      } else {
        const r = await fetch('/api/v1/try', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` }, body: JSON.stringify({ model: chosen, prompt }) });
        const j = (await r.json()) as TryReply;
        if (r.status === 429 && (j as { code?: string }).code === 'rate_limited') throw new Error(rateLimitedText(Number(r.headers.get('retry-after')), lang));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setAnswer(j.answer || (ar ? 'النموذج لم يُرجع نصًا.' : 'The model returned no text.'));
        setUsage(j.usage ?? null);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return <section className="section live-try" aria-labelledby="live-title"><div className="live-try-heading"><span className="section-kicker">LIVE / {activeMode === 'credits' ? 'WASL CREDITS' : 'BRING YOUR OWN KEY'}</span><h2 id="live-title">{ar ? 'جرّب ردًا حقيقيًا' : 'Run a real request'}</h2>
    <div className="mode-switch" role="tablist">
      <button role="tab" aria-selected={activeMode === 'credits'} className={activeMode === 'credits' ? 'on' : ''} onClick={() => creditsAvailable ? setMode('credits') : !session?.user ? onSignIn() : undefined} disabled={!!session?.user && !session.features.inference}><Wallet size={15} />{ar ? 'رصيد وصل' : 'Wasl credits'}</button>
      <button role="tab" aria-selected={activeMode === 'byok'} className={activeMode === 'byok' ? 'on' : ''} onClick={() => setMode('byok')}><ShieldCheck size={15} />{ar ? 'مفتاح OpenRouter الخاص بك' : 'Your OpenRouter key'}</button>
    </div>
    <p>{activeMode === 'credits'
      ? (ar ? 'يُخصم الطلب من رصيد حسابك في وصل بنفس سعر واجهة API. يظهر في سجل الاستخدام.' : 'Charged to your Wasl balance at API rates and recorded in your usage history.')
      : (ar ? 'تجربة اختيارية تستخدم رصيد حساب OpenRouter الخاص بك. المفتاح يُرسل مع الطلب ولا يُحفظ.' : 'Optional test charged to your own OpenRouter account. The key is sent with this request and is not stored.')}
      {!session?.user && <> {ar ? 'سجّل الدخول لاستخدام رصيد وصل.' : 'Sign in to use Wasl credits.'}</>}
      {session?.user && !session.features.inference && <> {ar ? 'الاستدلال المدفوع غير مفعّل على هذه النسخة.' : 'Paid inference is not activated on this deployment.'}</>}</p></div>
    <form onSubmit={submit} className="live-try-form">
      {activeMode === 'byok' && <label>{ar ? 'مفتاح OpenRouter' : 'OpenRouter API key'}<span className="live-key-field"><input type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="sk-or-…" required /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide key' : 'Show key'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>}
      <label className={activeMode === 'credits' ? 'live-prompt' : ''}>{ar ? 'النموذج' : 'Model'}<select value={chosen} onChange={e => setModel(e.target.value)}>{textModels.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select></label>
      <label className="live-prompt">{ar ? 'رسالتك' : 'Your message'}<textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder={ar ? 'اكتب سؤالك هنا...' : 'Type a prompt...'} required /></label>
      <div className="live-submit"><span><ShieldCheck size={16} />{activeMode === 'byok' ? (ar ? 'لا نحفظ المفتاح أو المحادثة' : 'No key or conversation storage') : (ar ? 'لا نحفظ نص المحادثة' : 'Conversation text is not stored')}</span>
        <button className="button-primary" type="submit" disabled={busy || !prompt.trim() || (activeMode === 'byok' && !key.trim())}>{busy ? (ar ? 'جارٍ الإرسال...' : 'Sending...') : (ar ? 'أرسل طلبًا حقيقيًا' : 'Send live request')} <Send size={16} /></button></div>
      {error && <p className="live-error" role="alert">{error}</p>}
      {answer && <div className="live-answer" aria-live="polite"><strong>{ar ? 'رد النموذج' : 'Model response'}</strong><p>{answer}</p>{usage && <small>{ar ? 'رموز الإدخال' : 'Input tokens'}: {usage.prompt_tokens ?? '—'} · {ar ? 'رموز الإخراج' : 'Output tokens'}: {usage.completion_tokens ?? '—'}{charged !== null ? ` · ${ar ? 'الخصم' : 'charged'} $${charged.toFixed(6)}` : typeof usage.cost === 'number' ? ` · $${usage.cost.toFixed(6)}` : ''}</small>}</div>}
    </form>
    {activeMode === 'byok' && <p className="live-fine"><a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">{ar ? 'إدارة مفاتيح OpenRouter' : 'Manage OpenRouter keys'} <ArrowUpRight size={13} /></a></p>}
  </section>;
}
