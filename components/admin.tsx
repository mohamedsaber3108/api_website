'use client';
import { useCallback, useEffect, useState } from 'react';
import { Activity, Cpu, FileClock, LayoutDashboard, LifeBuoy, Users } from 'lucide-react';
import { api, ApiError, errorMessage, usd, type SessionInfo } from '../lib/client-api';
import MfaPanel from './mfa';

type Tab = 'overview' | 'users' | 'tickets' | 'models' | 'incidents' | 'audit';
type Overview = { users: { total: number; last30Days: number }; activeKeys: number; openTickets: number; revenueLast30DaysMinor: number; usageLast30Days: { requests: number; billedMicroUsd: number; providerMicroUsd: number }; customerCreditsOutstandingMicroUsd: number; recentSignups: { id: string; email: string; name: string | null; createdAt: number }[] };
type User = { id: string; email: string; name: string | null; role: string; status: string; provider: string; emailVerified: boolean; createdAt: number; lastLoginAt: number | null; balanceMicroUsd: number };
type Ticket = { id: string; email: string; name: string; subject: string; status: string; priority: string; createdAt: number; updatedAt: number | null };
type Msg = { id: string; authorRole: string; authorName: string; body: string; createdAt: number };
type Incident = { id: string; title: string; body: string; status: string; severity: string; createdAt: number; resolvedAt: number | null };
type AuditEvent = { id: string; actorId: string | null; action: string; targetType: string | null; targetId: string | null; ip: string | null; createdAt: number; meta: unknown };
type ModelCfg = { modelId: string; enabled: boolean; markupPercent: number | null; note: string | null; updatedAt: number };

export default function AdminConsole({ lang, session }: { lang: 'ar' | 'en'; session: SessionInfo }) {
  const ar = lang === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const isAdmin = session.user?.role === 'admin';
  const [tab, setTab] = useState<Tab>(isAdmin ? 'overview' : 'tickets');
  // Admins must pass MFA before any admin data loads; support staff are not required yet.
  const [mfa, setMfa] = useState<'checking' | 'ok' | 'need'>(isAdmin ? 'checking' : 'ok');
  const [mfaReason, setMfaReason] = useState('');
  useEffect(() => { if (isAdmin) api<{ verified: boolean }>('/api/auth/mfa/status').then(s => setMfa(s.verified ? 'ok' : 'need')).catch(() => setMfa('need')); }, [isAdmin]);
  // Step-up shows the MFA panel above the console; the console stays mounted so a typed credit form is not lost (WCAG 3.3.7).
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const stepUp = () => { setMfaReason(tr('لتعديل الرصيد أدخل رمزًا جديدًا (صالح ١٥ دقيقة). ما كتبته محفوظ.', 'To change credit, enter a fresh code (valid for 15 minutes). What you typed is kept.')); setStepUpOpen(true); };
  const fmt = (t: number) => new Date(t).toLocaleString(ar ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const tabs: { id: Tab; icon: typeof Users; label: string; admin: boolean }[] = [
    { id: 'overview', icon: LayoutDashboard, label: tr('نظرة عامة', 'Overview'), admin: false },
    { id: 'users', icon: Users, label: tr('المستخدمون', 'Users'), admin: true },
    { id: 'tickets', icon: LifeBuoy, label: tr('التذاكر', 'Tickets'), admin: false },
    { id: 'models', icon: Cpu, label: tr('النماذج والتسعير', 'Models & pricing'), admin: true },
    { id: 'incidents', icon: Activity, label: tr('الحوادث', 'Incidents'), admin: false },
    { id: 'audit', icon: FileClock, label: tr('سجل التدقيق', 'Audit log'), admin: true },
  ];
  if (mfa !== 'ok') return <main className="inner-page"><section className="page-heading section"><span className="section-kicker">WASL / ADMIN</span><h1>{tr('لوحة الإدارة', 'Admin console')}</h1><div className="page-heading-art">◈</div></section>
    <section className="section">{mfa === 'checking' ? <p className="muted" role="status">{tr('جارٍ التحميل…', 'Loading…')}</p> : <MfaPanel tr={tr} reason={mfaReason} onVerified={() => { setMfaReason(''); setMfa('ok'); }} />}</section></main>;
  return <main className="inner-page"><section className="page-heading section"><span className="section-kicker">WASL / ADMIN</span><h1>{tr('لوحة الإدارة', 'Admin console')}</h1><div className="page-heading-art">◈</div></section>
    {stepUpOpen && <section className="section"><MfaPanel tr={tr} reason={mfaReason} onVerified={() => { setMfaReason(''); setStepUpOpen(false); }} /></section>}
    <section className="section dashboard-app"><aside className="dash-nav">{tabs.filter(t => isAdmin || !t.admin).map(t => <button key={t.id} className={tab === t.id ? 'dash-selected' : ''} onClick={() => setTab(t.id)}><t.icon size={18} />{t.label}</button>)}</aside>
      <div className="dash-body">
        {tab === 'overview' && <OverviewTab tr={tr} fmt={fmt} />}
        {tab === 'users' && <UsersTab tr={tr} fmt={fmt} onStepUp={stepUp} />}
        {tab === 'tickets' && <TicketsTab tr={tr} fmt={fmt} />}
        {tab === 'models' && <ModelsTab tr={tr} fmt={fmt} />}
        {tab === 'incidents' && <IncidentsTab tr={tr} fmt={fmt} canEdit={isAdmin} />}
        {tab === 'audit' && <AuditTab fmt={fmt} />}
      </div></section></main>;
}

type P = { tr: (a: string, e: string) => string; fmt: (t: number) => string };

function OverviewTab({ tr, fmt }: P) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Overview>('/api/admin/overview').then(setO).catch(e => setError(errorMessage(e))); }, []);
  if (error) return <p className="live-error">{error}</p>;
  if (!o) return <p className="muted">…</p>;
  const margin = o.usageLast30Days.billedMicroUsd - o.usageLast30Days.providerMicroUsd;
  return <><div className="stat-grid four">
    <div className="stat-card"><span>{tr('المستخدمون', 'Users')}</span><strong>{o.users.total}</strong><small>+{o.users.last30Days} / 30d</small></div>
    <div className="stat-card"><span>{tr('إيراد 30 يومًا', 'Revenue 30d')}</span><strong>${(o.revenueLast30DaysMinor / 100).toFixed(2)}</strong></div>
    <div className="stat-card"><span>{tr('طلبات 30 يومًا', 'Requests 30d')}</span><strong>{o.usageLast30Days.requests}</strong><small>{tr('هامش', 'margin')} {usd(margin, 4)}</small></div>
    <div className="stat-card"><span>{tr('أرصدة العملاء', 'Customer credits')}</span><strong>{usd(o.customerCreditsOutstandingMicroUsd)}</strong></div>
    <div className="stat-card"><span>{tr('مفاتيح فعّالة', 'Active keys')}</span><strong>{o.activeKeys}</strong></div>
    <div className="stat-card"><span>{tr('تذاكر مفتوحة', 'Open tickets')}</span><strong>{o.openTickets}</strong></div>
  </div><div className="dash-panel"><h3>{tr('أحدث التسجيلات', 'Recent sign-ups')}</h3><div className="rows">{o.recentSignups.map(u => <div key={u.id}><span><b>{u.name || u.email}</b><small>{u.email} · {fmt(u.createdAt)}</small></span></div>)}</div></div></>;
}

function UsersTab({ tr, fmt, onStepUp }: P & { onStepUp: () => void }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [credit, setCredit] = useState<{ id: string; amount: string; note: string } | null>(null);
  const load = useCallback(() => api<{ users: User[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`).then(r => setUsers(r.users)).catch(e => setError(errorMessage(e))), [q]);
  useEffect(() => { load(); }, [load]);
  const patch = async (id: string, body: object) => { try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body }); await load(); } catch (e) { setError(errorMessage(e)); } };
  return <div className="dash-panel"><div className="panel-head"><h3>{tr('المستخدمون', 'Users')}</h3><input placeholder={tr('بحث بالبريد أو الاسم', 'Search email or name')} value={q} onChange={e => setQ(e.target.value)} /></div>
    {error && <p className="live-error">{error}</p>}
    <div className="rows">{users.map(u => <div key={u.id} className="row-wrap"><span><b>{u.name || u.email}</b><small>{u.email} · {u.provider} · {u.emailVerified ? '✓' : tr('غير مؤكد', 'unverified')} · {fmt(u.createdAt)} · {usd(u.balanceMicroUsd, 4)}</small></span>
      <span className="row-actions">
        <select aria-label="role" value={u.role} disabled={u.status === 'deleted'} onChange={e => patch(u.id, { role: e.target.value })}><option>customer</option><option>support</option><option>admin</option></select>
        {u.status !== 'deleted' && <button className="pill-link" onClick={() => { if (confirm(u.status === 'active' ? tr('إيقاف الحساب وإلغاء مفاتيحه؟', 'Suspend this account and revoke its keys?') : tr('إعادة التفعيل؟', 'Reactivate?'))) patch(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }); }}>{u.status}</button>}
        <button className="pill-link" onClick={() => setCredit({ id: u.id, amount: '', note: '' })}>{tr('رصيد', 'Credit')}</button></span>
      {credit?.id === u.id && <form className="form-row" onSubmit={async e => { e.preventDefault(); try { await api(`/api/admin/users/${u.id}/credits`, { method: 'POST', body: { amountUsd: Number(credit.amount), note: credit.note, requestKey: crypto.randomUUID() } }); setCredit(null); await load(); } catch (err) { if (err instanceof ApiError && (err.code === 'mfa_recent_required' || err.code === 'mfa_required')) onStepUp(); else setError(errorMessage(err)); } }}>
        <input type="number" step="0.01" required placeholder="USD (+/-)" value={credit.amount} onChange={e => setCredit({ ...credit, amount: e.target.value })} /><input required minLength={3} placeholder={tr('السبب', 'Reason')} value={credit.note} onChange={e => setCredit({ ...credit, note: e.target.value })} /><button className="button-dark">{tr('تطبيق', 'Apply')}</button><button type="button" className="link" onClick={() => setCredit(null)}>×</button></form>}</div>)}</div></div>;
}

function TicketsTab({ tr, fmt }: P) {
  const [status, setStatus] = useState('open');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [open, setOpen] = useState<{ ticket: Ticket; messages: Msg[] } | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ tickets: Ticket[] }>(`/api/admin/tickets${status ? `?status=${status}` : ''}`).then(r => setTickets(r.tickets)).catch(e => setError(errorMessage(e))), [status]);
  useEffect(() => { load(); }, [load]);
  const show = (id: string) => api<{ ticket: Ticket; messages: Msg[] }>(`/api/admin/tickets/${id}`).then(setOpen).catch(e => setError(errorMessage(e)));
  const update = async (body: object) => { if (!open) return; try { await api(`/api/admin/tickets/${open.ticket.id}`, { method: 'PATCH', body }); await show(open.ticket.id); await load(); } catch (e) { setError(errorMessage(e)); } };
  return <div className="dash-panel">{error && <p className="live-error">{error}</p>}
    {open ? <div><button className="link" onClick={() => setOpen(null)}>← {tr('رجوع', 'Back')}</button><h3>{open.ticket.subject}</h3><p className="muted">{open.ticket.name} · {open.ticket.email}</p>
      <div className="form-row"><select value={open.ticket.status} onChange={e => update({ status: e.target.value })}>{['open', 'pending', 'resolved', 'closed'].map(s => <option key={s}>{s}</option>)}</select><select value={open.ticket.priority} onChange={e => update({ priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map(s => <option key={s}>{s}</option>)}</select></div>
      <div className="thread">{open.messages.map(m => <div key={m.id} className={m.authorRole === 'staff' ? 'staff' : ''}><small>{m.authorName} · {fmt(m.createdAt)}</small><p>{m.body}</p></div>)}</div>
      <form className="auth-form" onSubmit={async e => { e.preventDefault(); try { await api(`/api/admin/tickets/${open.ticket.id}`, { method: 'POST', body: { body: reply } }); setReply(''); await show(open.ticket.id); await load(); } catch (err) { setError(errorMessage(err)); } }}><textarea required minLength={2} maxLength={4000} value={reply} onChange={e => setReply(e.target.value)} placeholder={tr('رد فريق الدعم…', 'Staff reply…')} /><button className="button-primary">{tr('إرسال الرد', 'Send reply')}</button></form></div>
    : <><div className="panel-head"><h3>{tr('التذاكر', 'Tickets')}</h3><select value={status} onChange={e => setStatus(e.target.value)}><option value="">{tr('الكل', 'All')}</option>{['open', 'pending', 'resolved', 'closed'].map(s => <option key={s}>{s}</option>)}</select></div>
      {tickets.length === 0 ? <p className="muted">—</p> : <div className="rows">{tickets.map(t => <div key={t.id}><span><b>{t.subject}</b><small>{t.email} · {t.priority} · {fmt(t.updatedAt ?? t.createdAt)}</small></span><button className="pill-link" onClick={() => show(t.id)}>{t.status}</button></div>)}</div>}</>}</div>;
}

function ModelsTab({ tr, fmt }: P) {
  const [data, setData] = useState<{ defaultMarkupPercent: number; configs: ModelCfg[] } | null>(null);
  const [form, setForm] = useState({ modelId: '', enabled: true, markup: '', note: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ defaultMarkupPercent: number; configs: ModelCfg[] }>('/api/admin/models').then(setData).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const save = async (body: { modelId: string; enabled: boolean; markupPercent: number | null; note: string | null }) => { try { await api('/api/admin/models', { method: 'PUT', body }); await load(); } catch (e) { setError(errorMessage(e)); } };
  return <div className="dash-panel"><h3>{tr('النماذج والتسعير', 'Models & pricing')}</h3><p className="muted">{tr('الهامش الافتراضي', 'Default markup')}: {data?.defaultMarkupPercent ?? '…'}% ({tr('يُضبط بالمتغير', 'set via')} DEFAULT_MARKUP_PERCENT)</p>{error && <p className="live-error">{error}</p>}
    <form className="form-row" onSubmit={e => { e.preventDefault(); save({ modelId: form.modelId.trim(), enabled: form.enabled, markupPercent: form.markup === '' ? null : Number(form.markup), note: form.note || null }); setForm({ modelId: '', enabled: true, markup: '', note: '' }); }}>
      <input required placeholder="provider/model-id" value={form.modelId} onChange={e => setForm({ ...form, modelId: e.target.value })} /><input type="number" min={0} max={500} placeholder={tr('هامش %', 'Markup %')} value={form.markup} onChange={e => setForm({ ...form, markup: e.target.value })} /><label className="chk"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />{tr('مفعّل', 'Enabled')}</label><input placeholder={tr('ملاحظة', 'Note')} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /><button className="button-dark">{tr('حفظ', 'Save')}</button></form>
    <div className="rows">{data?.configs.map(c => <div key={c.modelId}><span><b>{c.modelId}</b><small>{c.markupPercent ?? tr('افتراضي', 'default')}% · {c.note || ''} · {fmt(c.updatedAt)}</small></span><button className="pill-link" onClick={() => save({ modelId: c.modelId, enabled: !c.enabled, markupPercent: c.markupPercent, note: c.note })}>{c.enabled ? tr('مفعّل', 'enabled') : tr('معطّل', 'disabled')}</button></div>)}</div></div>;
}

function IncidentsTab({ tr, fmt, canEdit }: P & { canEdit: boolean }) {
  const [items, setItems] = useState<Incident[]>([]);
  const [form, setForm] = useState({ title: '', body: '', severity: 'minor' });
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ incidents: Incident[] }>('/api/admin/incidents').then(r => setItems(r.incidents)).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  return <div className="dash-panel"><h3>{tr('الحوادث', 'Incidents')}</h3>{error && <p className="live-error">{error}</p>}
    {canEdit && <form className="auth-form" onSubmit={async e => { e.preventDefault(); try { await api('/api/admin/incidents', { method: 'POST', body: form }); setForm({ title: '', body: '', severity: 'minor' }); await load(); } catch (err) { setError(errorMessage(err)); } }}>
      <input required minLength={3} placeholder={tr('العنوان', 'Title')} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /><textarea required minLength={3} placeholder={tr('التفاصيل', 'Details')} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} /><select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}><option>minor</option><option>major</option><option>critical</option></select><button className="button-dark">{tr('نشر حادثة', 'Publish incident')}</button></form>}
    <div className="rows">{items.map(i => <div key={i.id}><span><b>{i.title}</b><small>{i.severity} · {fmt(i.createdAt)} · {i.body}</small></span>{canEdit ? <select value={i.status} onChange={async e => { try { await api('/api/admin/incidents', { method: 'PATCH', body: { id: i.id, status: e.target.value } }); await load(); } catch (err) { setError(errorMessage(err)); } }}>{['investigating', 'identified', 'monitoring', 'resolved'].map(s => <option key={s}>{s}</option>)}</select> : <span className="role-pill">{i.status}</span>}</div>)}</div></div>;
}

function AuditTab({ fmt }: { fmt: (t: number) => string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ events: AuditEvent[] }>('/api/admin/audit?limit=100').then(r => setEvents(r.events)).catch(e => setError(errorMessage(e))); }, []);
  return <div className="dash-panel"><h3>Audit log</h3>{error && <p className="live-error">{error}</p>}<div className="rows">{events.map(e => <div key={e.id}><span><b>{e.action}</b><small>{fmt(e.createdAt)} · {e.actorId ?? '—'} → {e.targetType}:{e.targetId} · {e.ip}</small></span></div>)}</div></div>;
}
