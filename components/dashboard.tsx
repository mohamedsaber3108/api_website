'use client';
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, CreditCard, Download, KeyRound, LifeBuoy, LockKeyhole, Plus, RefreshCw, Settings, Trash2, Wallet, Zap, Copy, Receipt } from 'lucide-react';
import { api, ApiError, errorMessage, usd, type SessionInfo } from '../lib/client-api';
import { inferenceOffMessage } from '../lib/checkout-error';

type Lang = 'ar' | 'en';
type Tab = 'overview' | 'keys' | 'usage' | 'billing' | 'support' | 'settings';
type Key = { id: string; name: string; prefix: string; scopes: string; createdAt: number; lastUsedAt: number | null; expiresAt: number | null; rateLimitPerMin: number };
type UsageRow = { id: string; model: string; inputTokens: number; outputTokens: number; costMicroUsd: number; createdAt: number; status: string; source: string };
type Account = { account: { email: string; name: string; role: string; provider: string; emailVerified: boolean; preferences: Record<string, string> }; balanceMicroUsd: number; month: { requests: number; costMicroUsd: number; tokens: number }; keys: Key[]; usage: UsageRow[]; service: { inference: boolean; checkout: boolean } };
type Summary = { days: number; daily: { day: string; requests: number; tokens: number; costMicroUsd: number }[]; byModel: { model: string; requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number }[]; totals: { requests: number; errors: number; costMicroUsd: number } | undefined };
type Billing = { balanceMicroUsd: number; packages: number[]; checkoutEnabled: boolean; inferenceEnabled?: boolean; emailVerified: boolean; transactions: { id: string; deltaMicroUsd: number; type: string; note: string | null; createdAt: number }[]; payments: { id: string; amountMinor: number; status: string; createdAt: number }[]; invoices: { id: string; number: string; amountMinor: number; currency: string; description: string; issuedAt: number }[] };
type Ticket = { id: string; subject: string; status: string; createdAt: number; updatedAt: number | null };
type Msg = { id: string; authorRole: string; authorName: string; body: string; createdAt: number };

const TABS: { id: Tab; icon: typeof Zap; ar: string; en: string }[] = [
  { id: 'overview', icon: Zap, ar: 'نظرة عامة', en: 'Overview' },
  { id: 'keys', icon: KeyRound, ar: 'مفاتيح API', en: 'API keys' },
  { id: 'usage', icon: BarChart3, ar: 'الاستخدام', en: 'Usage' },
  { id: 'billing', icon: Wallet, ar: 'الرصيد والفواتير', en: 'Billing' },
  { id: 'support', icon: LifeBuoy, ar: 'الدعم', en: 'Support' },
  { id: 'settings', icon: Settings, ar: 'الإعدادات', en: 'Settings' },
];

function Bars({ data, label }: { data: { day: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return <div className="bars" role="img" aria-label={label}>{data.map(d => <div key={d.day} title={`${d.day}: ${d.value}`}><span style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} /><small>{d.day.slice(5)}</small></div>)}{data.length === 0 && <p className="muted">—</p>}</div>;
}

export default function Dashboard({ lang, session, refreshSession, go }: { lang: Lang; session: SessionInfo; refreshSession: () => Promise<void> | void; go: (p: string) => void }) {
  const ar = lang === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const user = session.user!;
  const locale = ar ? 'ar-EG' : 'en-US';
  const [tab, setTab] = useState<Tab>(() => {
    const q = typeof window === 'undefined' ? null : new URLSearchParams(location.search).get('tab');
    return TABS.some(t => t.id === q) ? (q as Tab) : 'overview';
  });
  const [data, setData] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(() => api<Account>('/api/account').then(d => { setData(d); setError(''); }).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const fmt = (t: number) => new Date(t).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return <section className="section dashboard-app"><aside className="dash-nav">
    <div className="dash-user"><strong>{user.name}</strong><small>{user.email}</small>{user.role !== 'customer' && <span className="role-pill">{user.role}</span>}</div>
    {TABS.map(t => <button key={t.id} className={tab === t.id ? 'dash-selected' : ''} onClick={() => { setTab(t.id); setNotice(''); }}><t.icon size={18} />{tr(t.ar, t.en)}</button>)}
    {(user.role === 'admin' || user.role === 'support') && <button onClick={() => go('admin')}><LockKeyhole size={18} />{tr('لوحة الإدارة', 'Admin console')}</button>}
  </aside><div className="dash-body">
    {!user.emailVerified && <VerifyBanner ar={ar} />}
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="auth-info">{notice}</p>}
    {!data ? <p className="muted">{tr('جارٍ التحميل…', 'Loading…')}</p> : <>
      {tab === 'overview' && <Overview ar={ar} data={data} fmt={fmt} setTab={setTab} />}
      {tab === 'keys' && <Keys ar={ar} keys={data.keys} fmt={fmt} reload={load} inference={data.service.inference} />}
      {tab === 'usage' && <UsageTab ar={ar} />}
      {tab === 'billing' && <BillingTab ar={ar} fmt={fmt} />}
      {tab === 'support' && <SupportTab ar={ar} fmt={fmt} />}
      {tab === 'settings' && <SettingsTab ar={ar} data={data} fmt={fmt} reload={load} refreshSession={refreshSession} go={go} setNotice={setNotice} />}
    </>}
  </div></section>;
}

function VerifyBanner({ ar }: { ar: boolean }) {
  const [msg, setMsg] = useState('');
  const [dev, setDev] = useState('');
  return <div className="verify-banner"><span>{ar ? 'بريدك الإلكتروني غير مؤكد. أكّده لتتمكن من شحن الرصيد.' : 'Your email is not verified. Verify it to add credits.'}</span>
    <button onClick={async () => { try { const r = await api<{ delivered?: boolean; dev_verify_token?: string }>('/api/auth/resend-verification', { method: 'POST', body: {} }); setMsg(r.delivered ? (ar ? 'أُرسل الرابط.' : 'Link sent.') : (ar ? 'تعذّر إرسال البريد.' : 'Email could not be sent.')); if (r.dev_verify_token) setDev(r.dev_verify_token); } catch (e) { setMsg(errorMessage(e)); } }}>{ar ? 'أعد إرسال الرابط' : 'Resend link'}</button>
    {msg && <small>{msg}</small>}{dev && <a href={`/verify-email?token=${dev}`}>dev: verify</a>}</div>;
}

function Overview({ ar, data, fmt, setTab }: { ar: boolean; data: Account; fmt: (t: number) => string; setTab: (t: Tab) => void }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => { api<Summary>('/api/account/usage?days=14').then(setSummary).catch(() => setSummary(null)); }, []);
  return <>
    <div className="stat-grid four">
      <div className="stat-card"><span><Wallet size={19} /> {tr('الرصيد', 'Balance')}</span><strong>{usd(data.balanceMicroUsd)}</strong><small><button className="link" onClick={() => setTab('billing')}>{tr('شحن الرصيد', 'Add credits')}</button></small></div>
      <div className="stat-card"><span><Zap size={19} /> {tr('طلبات هذا الشهر', 'Requests this month')}</span><strong>{data.month.requests.toLocaleString()}</strong><small>{data.month.tokens.toLocaleString()} tokens</small></div>
      <div className="stat-card"><span><CreditCard size={19} /> {tr('إنفاق الشهر', 'Spend this month')}</span><strong>{usd(data.month.costMicroUsd, 4)}</strong></div>
      <div className="stat-card"><span><KeyRound size={19} /> {tr('مفاتيح فعّالة', 'Active keys')}</span><strong>{data.keys.length}</strong><small><button className="link" onClick={() => setTab('keys')}>{tr('إدارة', 'Manage')}</button></small></div>
    </div>
    {!data.service.inference && <p className="auth-info">{tr('خدمة الاستدلال غير مفعّلة على هذه النسخة بعد.', 'Inference is not activated on this deployment yet.')}</p>}
    <div className="dash-panel"><h3>{tr('آخر 14 يومًا', 'Last 14 days')}</h3><Bars label="requests per day" data={(summary?.daily ?? []).map(d => ({ day: d.day, value: d.requests }))} /></div>
    <div className="dash-panel"><h3>{tr('آخر الطلبات', 'Recent requests')}</h3>{data.usage.length === 0 ? <p className="muted">{tr('لا توجد طلبات بعد.', 'No requests yet.')}</p> : <div className="rows">{data.usage.slice(0, 10).map(u => <div key={u.id}><span><b>{u.model}</b><small>{fmt(u.createdAt)} · {u.inputTokens}+{u.outputTokens} tokens · {u.source}{u.status !== 'ok' ? ` · ${u.status}` : ''}</small></span><strong>{usd(u.costMicroUsd, 6)}</strong></div>)}</div>}</div></>;
}

function Keys({ ar, keys, fmt, reload, inference }: { ar: boolean; keys: Key[]; fmt: (t: number) => string; reload: () => Promise<void>; inference: boolean }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [name, setName] = useState('Development');
  const [scopes, setScopes] = useState<string[]>(['chat']);
  const [days, setDays] = useState<number | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setError('');
    try { const r = await api<{ secret: string }>('/api/account/keys', { method: 'POST', body: { name, scopes, expiresInDays: days } }); setSecret(r.secret); await reload(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function rotate(id: string) {
    if (!confirm(tr('سيتم إلغاء المفتاح الحالي وإنشاء بديل. متابعة؟', 'The current key will be revoked and replaced. Continue?'))) return;
    try { const r = await api<{ secret: string }>('/api/account/keys/rotate', { method: 'POST', body: { id } }); setSecret(r.secret); await reload(); } catch (e) { setError(errorMessage(e)); }
  }
  async function revoke(id: string) {
    if (!confirm(tr('إلغاء المفتاح نهائيًا؟', 'Revoke this key permanently?'))) return;
    try { await api('/api/account/keys', { method: 'DELETE', body: { id } }); setSecret(''); await reload(); } catch (e) { setError(errorMessage(e)); }
  }
  return <div className="dash-panel"><h3>{tr('مفاتيح API', 'API keys')} <small>{keys.length}/10</small></h3>
    <p className="muted">{tr('يظهر المفتاح مرة واحدة عند إنشائه. استخدمه في ', 'A key is shown once when created. Use it with ')}<code>Authorization: Bearer wasl_…</code>{!inference && ` — ${tr('الاستدلال غير مفعّل بعد', 'inference is not activated yet')}`}</p>
    <div className="form-row"><input aria-label={tr('اسم المفتاح', 'Key name')} value={name} maxLength={48} onChange={e => setName(e.target.value)} />
      <select aria-label={tr('الصلاحية', 'Expiry')} value={days ?? ''} onChange={e => setDays(e.target.value ? Number(e.target.value) : null)}><option value="">{tr('بدون انتهاء', 'No expiry')}</option><option value="30">30 {tr('يومًا', 'days')}</option><option value="90">90 {tr('يومًا', 'days')}</option><option value="365">365 {tr('يومًا', 'days')}</option></select>
      {(['chat', 'usage'] as const).map(s => <label key={s} className="chk"><input type="checkbox" checked={scopes.includes(s)} onChange={e => setScopes(e.target.checked ? [...scopes, s] : scopes.filter(x => x !== s))} />{s}</label>)}
      <button className="button-dark" onClick={create} disabled={busy || name.trim().length < 2 || scopes.length === 0 || keys.length >= 10}><Plus size={16} />{tr('إنشاء مفتاح', 'Create key')}</button></div>
    {error && <p className="live-error" role="alert">{error}</p>}
    {secret && <div className="account-secret"><b>{tr('انسخه الآن، لن يظهر مرة ثانية', 'Copy it now; it will not be shown again')}</b><code dir="ltr">{secret}</code><button onClick={() => navigator.clipboard.writeText(secret)}><Copy size={15} />{tr('نسخ', 'Copy')}</button></div>}
    <div className="rows">{keys.length === 0 ? <p className="muted">{tr('لا توجد مفاتيح بعد.', 'No keys yet.')}</p> : keys.map(k => <div key={k.id}><span><b>{k.name}</b><small><code>{k.prefix}…</code> · {k.scopes} · {k.rateLimitPerMin}/min · {tr('أُنشئ', 'created')} {fmt(k.createdAt)} · {k.lastUsedAt ? `${tr('آخر استخدام', 'last used')} ${fmt(k.lastUsedAt)}` : tr('لم يُستخدم', 'never used')}{k.expiresAt ? ` · ${tr('ينتهي', 'expires')} ${fmt(k.expiresAt)}` : ''}</small></span>
      <span className="row-actions"><button aria-label={tr('تدوير', 'Rotate')} title={tr('تدوير', 'Rotate')} onClick={() => rotate(k.id)}><RefreshCw size={17} /></button><button aria-label={tr('إلغاء', 'Revoke')} title={tr('إلغاء', 'Revoke')} onClick={() => revoke(k.id)}><Trash2 size={17} /></button></span></div>)}</div></div>;
}

function UsageTab({ ar }: { ar: boolean }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Summary>(`/api/account/usage?days=${days}`).then(setS).catch(e => setError(errorMessage(e))); }, [days]);
  return <div className="dash-panel"><div className="panel-head"><h3>{tr('الاستخدام', 'Usage')}</h3><div className="form-row"><select value={days} onChange={e => setDays(Number(e.target.value))}>{[7, 30, 90].map(d => <option key={d} value={d}>{d} {tr('يومًا', 'days')}</option>)}</select><a className="pill-link" href={`/api/account/usage/export?days=${days}`}><Download size={15} /> CSV</a></div></div>
    {error && <p className="live-error">{error}</p>}
    {s && <><div className="stat-grid four"><div className="stat-card"><span>{tr('الطلبات', 'Requests')}</span><strong>{(s.totals?.requests ?? 0).toLocaleString()}</strong></div><div className="stat-card"><span>{tr('الإنفاق', 'Spend')}</span><strong>{usd(s.totals?.costMicroUsd ?? 0, 4)}</strong></div><div className="stat-card"><span>{tr('أخطاء', 'Errors')}</span><strong>{s.totals?.errors ?? 0}</strong></div></div>
      <Bars label="spend per day" data={s.daily.map(d => ({ day: d.day, value: d.costMicroUsd }))} />
      <h3>{tr('حسب النموذج', 'By model')}</h3><div className="rows">{s.byModel.length === 0 ? <p className="muted">—</p> : s.byModel.map(m => <div key={m.model}><span><b>{m.model}</b><small>{m.requests} {tr('طلب', 'requests')} · {m.inputTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out</small></span><strong>{usd(m.costMicroUsd, 4)}</strong></div>)}</div></>}</div>;
}

function BillingTab({ ar, fmt }: { ar: boolean; fmt: (t: number) => string }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [b, setB] = useState<Billing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const status = typeof window === 'undefined' ? null : new URLSearchParams(location.search).get('payment');
  useEffect(() => { api<Billing>('/api/billing').then(setB).catch(e => setError(errorMessage(e))); }, []);
  async function buy(amountUsd: number) {
    setBusy(true); setError('');
    try { const r = await api<{ url: string }>('/api/billing/checkout', { method: 'POST', body: { amountUsd } }); window.location.assign(r.url); } catch (e) { setError(e instanceof ApiError && e.code === 'inference_not_enabled' ? inferenceOffMessage(ar ? 'ar' : 'en') : errorMessage(e)); setBusy(false); }
  }
  return <><div className="dash-panel"><h3>{tr('الرصيد', 'Balance')}: {b ? usd(b.balanceMicroUsd, 4) : '…'}</h3>
    {status === 'success' && <p className="auth-info">{tr('تم استلام الدفع. يُضاف الرصيد خلال لحظات بعد تأكيد المزوّد.', 'Payment received. Credits appear shortly after the provider confirms.')}</p>}
    {status === 'cancelled' && <p className="muted">{tr('أُلغيت عملية الدفع.', 'Checkout was cancelled.')}</p>}
    {error && <p className="live-error" role="alert">{error}</p>}
    {b && (b.checkoutEnabled ? <div className="packages">{b.inferenceEnabled === false && <p className="live-error" role="alert">{inferenceOffMessage(ar ? 'ar' : 'en')}</p>}{b.packages.map(p => <button key={p} className="button-dark" disabled={busy || !b.emailVerified || b.inferenceEnabled === false} onClick={() => buy(p)}>${p}</button>)}{!b.emailVerified && <small>{tr('أكّد بريدك أولًا.', 'Verify your email first.')}</small>}</div> : <p className="muted">{tr('الدفع الإلكتروني غير مفعّل بعد على هذه النسخة.', 'Online payments are not activated on this deployment yet.')}</p>)}</div>
    {b && <><div className="dash-panel"><h3><Receipt size={18} /> {tr('الفواتير', 'Invoices')}</h3>{b.invoices.length === 0 ? <p className="muted">—</p> : <div className="rows">{b.invoices.map(i => <div key={i.id}><span><b>{i.number}</b><small>{fmt(i.issuedAt)} · {i.description}</small></span><a className="pill-link" href={`/api/billing/invoices/${i.id}`} target="_blank" rel="noopener noreferrer">${(i.amountMinor / 100).toFixed(2)}</a></div>)}</div>}</div>
      <div className="dash-panel"><h3>{tr('سجل الرصيد', 'Transactions')}</h3>{b.transactions.length === 0 ? <p className="muted">—</p> : <div className="rows">{b.transactions.map(t => <div key={t.id}><span><b>{t.type}</b><small>{fmt(t.createdAt)}{t.note ? ` · ${t.note}` : ''}</small></span><strong className={t.deltaMicroUsd < 0 ? 'neg' : 'pos'}>{t.deltaMicroUsd > 0 ? '+' : ''}{usd(t.deltaMicroUsd, 4)}</strong></div>)}</div>}</div></>}</>;
}

function SupportTab({ ar, fmt }: { ar: boolean; fmt: (t: number) => string }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [open, setOpen] = useState<{ ticket: Ticket; messages: Msg[] } | null>(null);
  const [reply, setReply] = useState('');
  const [form, setForm] = useState({ subject: '', message: '' });
  const [error, setError] = useState('');
  const list = useCallback(() => api<{ tickets: Ticket[] }>('/api/support/tickets').then(r => setTickets(r.tickets)).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { list(); }, [list]);
  const show = (id: string) => api<{ ticket: Ticket; messages: Msg[] }>(`/api/support/tickets/${id}`).then(setOpen).catch(e => setError(errorMessage(e)));
  return <><div className="dash-panel"><h3>{tr('تذاكر الدعم', 'Support tickets')}</h3>{error && <p className="live-error">{error}</p>}
    {open ? <div><button className="link" onClick={() => setOpen(null)}>← {tr('رجوع', 'Back')}</button><h4>{open.ticket.subject} <span className="role-pill">{open.ticket.status}</span></h4>
      <div className="thread">{open.messages.map(m => <div key={m.id} className={m.authorRole === 'staff' ? 'staff' : ''}><small>{m.authorName} · {fmt(m.createdAt)}</small><p>{m.body}</p></div>)}</div>
      <form className="form-row" onSubmit={async e => { e.preventDefault(); try { await api(`/api/support/tickets/${open.ticket.id}`, { method: 'POST', body: { body: reply } }); setReply(''); await show(open.ticket.id); await list(); } catch (err) { setError(errorMessage(err)); } }}><input value={reply} onChange={e => setReply(e.target.value)} minLength={2} maxLength={4000} required placeholder={tr('اكتب ردك…', 'Write a reply…')} /><button className="button-dark">{tr('إرسال', 'Send')}</button></form></div>
      : tickets.length === 0 ? <p className="muted">{tr('لا توجد تذاكر.', 'No tickets yet.')}</p> : <div className="rows">{tickets.map(t => <div key={t.id}><span><b>{t.subject}</b><small>{fmt(t.createdAt)}</small></span><button className="pill-link" onClick={() => show(t.id)}>{t.status}</button></div>)}</div>}</div>
    <div className="dash-panel"><h3>{tr('تذكرة جديدة', 'New ticket')}</h3><form className="auth-form" onSubmit={async e => { e.preventDefault(); try { await api('/api/support', { method: 'POST', body: form }); setForm({ subject: '', message: '' }); await list(); } catch (err) { setError(errorMessage(err)); } }}>
      <label>{tr('الموضوع', 'Subject')}<input required minLength={3} maxLength={140} value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} /></label>
      <label>{tr('الرسالة', 'Message')}<textarea required minLength={10} maxLength={4000} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} /></label><button className="button-primary">{tr('إرسال', 'Submit')}</button></form></div></>;
}

type SessionRow = { id: string; createdAt: number; lastSeenAt: number; ip: string | null; userAgent: string | null; current: boolean };

function SettingsTab({ ar, data, fmt, reload, refreshSession, go, setNotice }: { ar: boolean; data: Account; fmt: (t: number) => string; reload: () => Promise<void>; refreshSession: () => Promise<void> | void; go: (p: string) => void; setNotice: (s: string) => void }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const password = data.account.provider === 'password';
  const [name, setName] = useState(data.account.name);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [del, setDel] = useState({ password: '', confirm: '' });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState('');
  const loadSessions = useCallback(() => password ? api<{ sessions: SessionRow[] }>('/api/auth/sessions').then(r => setSessions(r.sessions)).catch(() => {}) : Promise.resolve(), [password]);
  useEffect(() => { loadSessions(); }, [loadSessions]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setError(''); try { await fn(); setNotice(ok); } catch (e) { setError(errorMessage(e)); } };
  return <>{error && <p className="live-error" role="alert">{error}</p>}
    <div className="dash-panel"><h3>{tr('الملف الشخصي', 'Profile')}</h3><form className="form-row" onSubmit={e => { e.preventDefault(); run(async () => { await api('/api/account/profile', { method: 'PATCH', body: { name } }); await reload(); await refreshSession(); }, tr('تم الحفظ.', 'Saved.')); }}><input value={name} minLength={2} maxLength={80} onChange={e => setName(e.target.value)} /><button className="button-dark">{tr('حفظ', 'Save')}</button></form><small className="muted">{data.account.email}</small></div>
    {password && <><div className="dash-panel"><h3>{tr('تغيير كلمة المرور', 'Change password')}</h3><form className="auth-form" onSubmit={e => { e.preventDefault(); run(async () => { await api('/api/account/password', { method: 'POST', body: pw }); setPw({ currentPassword: '', newPassword: '' }); await loadSessions(); }, tr('تم تغيير كلمة المرور.', 'Password changed.')); }}>
      <label>{tr('الحالية', 'Current')}<input type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={e => setPw({ ...pw, currentPassword: e.target.value })} /></label>
      <label>{tr('الجديدة', 'New')}<input type="password" autoComplete="new-password" minLength={10} required value={pw.newPassword} onChange={e => setPw({ ...pw, newPassword: e.target.value })} /></label><button className="button-dark">{tr('تغيير', 'Change')}</button></form></div>
      <div className="dash-panel"><h3>{tr('الجلسات', 'Sessions')}</h3><div className="rows">{sessions.map(s => <div key={s.id}><span><b>{s.current ? tr('هذا الجهاز', 'This device') : (s.userAgent || 'Unknown').slice(0, 60)}</b><small>{s.ip} · {fmt(s.lastSeenAt)}</small></span>{!s.current && <button aria-label="Revoke session" onClick={() => run(async () => { await api('/api/auth/sessions', { method: 'DELETE', body: { id: s.id } }); await loadSessions(); }, tr('أُنهيت الجلسة.', 'Session ended.'))}><Trash2 size={16} /></button>}</div>)}</div>
        <button className="pill-link" onClick={() => run(async () => { await api('/api/auth/sessions', { method: 'DELETE', body: { others: true } }); await loadSessions(); }, tr('أُنهيت الجلسات الأخرى.', 'Other sessions ended.'))}>{tr('إنهاء كل الجلسات الأخرى', 'Sign out other devices')}</button></div></>}
    <div className="dash-panel"><h3>{tr('تسجيل الخروج', 'Sign out')}</h3>{password ? <button className="button-dark" onClick={async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); await refreshSession(); go('home'); }}>{tr('خروج', 'Sign out')}</button> : /* Hosting-platform route: full page load required. */ /* eslint-disable-line @next/next/no-html-link-for-pages */ <a className="pill-link" href="/signout-with-chatgpt?return_to=%2F" target="_top">{tr('خروج من ChatGPT', 'Sign out of ChatGPT')}</a>}</div>
    <div className="dash-panel danger"><h3>{tr('حذف الحساب', 'Delete account')}</h3><p className="muted">{tr('يُلغي المفاتيح ويمسح بياناتك الشخصية. يُحتفظ بسجلات الفوترة للمحاسبة. لا يمكن التراجع.', 'Revokes your keys and erases personal data. Billing records are kept for accounting. This cannot be undone.')}</p>
      <form className="auth-form" onSubmit={e => { e.preventDefault(); if (!confirm(tr('حذف الحساب نهائيًا؟', 'Delete your account permanently?'))) return; run(async () => { await api('/api/account', { method: 'DELETE', body: { password: del.password || undefined, confirm: del.confirm } }); await refreshSession(); go('home'); }, ''); }}>
        {password && <label>{tr('كلمة المرور', 'Password')}<input type="password" required value={del.password} onChange={e => setDel({ ...del, password: e.target.value })} /></label>}
        <label>{tr('اكتب DELETE للتأكيد', 'Type DELETE to confirm')}<input required value={del.confirm} onChange={e => setDel({ ...del, confirm: e.target.value })} /></label><button className="button-dark" disabled={del.confirm !== 'DELETE'}>{tr('حذف الحساب', 'Delete account')}</button></form></div></>;
}
