'use client';
import { useCallback, useEffect, useState } from 'react';
import { Activity, Cpu, FileClock, LayoutDashboard, LifeBuoy, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { api, ApiError, errorMessage, usd, type SessionInfo } from '../lib/client-api';
import { approvalCodeMessage } from '../lib/admin-error';
import Dialog from './dialog';
import MfaPanel from './mfa';
import SettingsTab from './admin-settings';
import SessionTimeout from './session-timeout';

type Tab = 'overview' | 'users' | 'approvals' | 'tickets' | 'models' | 'settings' | 'incidents' | 'audit';
type Overview = { users: { total: number; last30Days: number }; activeKeys: number; openTickets: number; revenueLast30DaysMinor: number; usageLast30Days: { requests: number; billedMicroUsd: number; providerMicroUsd: number }; customerCreditsOutstandingMicroUsd: number; recentSignups: { id: string; email: string; name: string | null; createdAt: number }[] };
type User = { id: string; email: string; name: string | null; role: string; status: string; provider: string; emailVerified: boolean; createdAt: number; lastLoginAt: number | null; balanceMicroUsd: number };
type Ticket = { id: string; email: string; name: string; subject: string; status: string; priority: string; createdAt: number; updatedAt: number | null };
type Msg = { id: string; authorRole: string; authorName: string; body: string; createdAt: number };
type Incident = { id: string; title: string; body: string; status: string; severity: string; createdAt: number; resolvedAt: number | null };
type AuditEvent = { id: string; seq: number | null; actorId: string | null; actorEmail: string | null; actorRole: string | null; action: string; targetType: string | null; targetId: string | null; ip: string | null; createdAt: number; meta: unknown; before: unknown; after: unknown; reason: string | null; result: 'success' | 'denied' | 'failed' | null };
type Req = { id: string; kind: 'credit_adjustment' | 'role_change' | 'flag_change'; status: string; payload: { amountUsd?: number; note?: string; role?: string; from?: string; flag?: string }; reason: string; target: { id: string; email: string | null }; requestedBy: { id: string; email: string | null }; createdAt: number; expiresAt: number };
type ModelCfg = { modelId: string; enabled: boolean; markupPercent: number | null; note: string | null; updatedAt: number };

export default function AdminConsole({ lang, session }: { lang: 'ar' | 'en'; session: SessionInfo }) {
  const ar = lang === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const isSuper = session.user?.role === 'super_admin';
  const isAdmin = session.user?.role === 'admin' || isSuper;
  const [tab, setTab] = useState<Tab>(isAdmin ? 'overview' : 'tickets');
  // All staff (support too, SEC-3b) must pass MFA before any admin data loads.
  const [mfa, setMfa] = useState<'checking' | 'ok' | 'need'>('checking');
  const [mfaReason, setMfaReason] = useState('');
  useEffect(() => { api<{ verified: boolean }>('/api/auth/mfa/status').then(s => setMfa(s.verified ? 'ok' : 'need')).catch(() => setMfa('need')); }, []);
  // Step-up shows the MFA panel above the console; the console stays mounted so a typed credit form is not lost (WCAG 3.3.7).
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const stepUp = () => { setMfaReason(tr('لتعديل الرصيد أدخل رمزًا جديدًا (صالح ١٥ دقيقة). ما كتبته محفوظ.', 'To change credit, enter a fresh code (valid for 15 minutes). What you typed is kept.')); setStepUpOpen(true); };
  const fmt = (t: number) => new Date(t).toLocaleString(ar ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const tabs: { id: Tab; icon: typeof Users; label: string; admin: boolean; superOnly?: boolean }[] = [
    { id: 'overview', icon: LayoutDashboard, label: tr('نظرة عامة', 'Overview'), admin: false },
    { id: 'users', icon: Users, label: tr('المستخدمون', 'Users'), admin: true },
    { id: 'approvals', icon: ShieldCheck, label: tr('الموافقات', 'Approvals'), admin: true },
    { id: 'tickets', icon: LifeBuoy, label: tr('التذاكر', 'Tickets'), admin: false },
    { id: 'models', icon: Cpu, label: tr('النماذج والتسعير', 'Models & pricing'), admin: true },
    { id: 'settings', icon: SlidersHorizontal, label: tr('الإعدادات', 'Settings'), admin: true },
    { id: 'incidents', icon: Activity, label: tr('الحوادث', 'Incidents'), admin: false },
    { id: 'audit', icon: FileClock, label: tr('سجل التدقيق', 'Audit log'), admin: true, superOnly: true },
  ];
  if (mfa !== 'ok') return <main className="inner-page"><section className="page-heading section"><span className="section-kicker">WASL / ADMIN</span><h1>{tr('لوحة الإدارة', 'Admin console')}</h1><div className="page-heading-art">◈</div></section>
    <section className="section">{mfa === 'checking' ? <p className="muted" role="status">{tr('جارٍ التحميل…', 'Loading…')}</p> : <MfaPanel tr={tr} reason={mfaReason} onVerified={() => { setMfaReason(''); setMfa('ok'); }} />}</section></main>;
  return <main className="inner-page"><section className="page-heading section"><span className="section-kicker">WASL / ADMIN</span><h1>{tr('لوحة الإدارة', 'Admin console')}</h1><div className="page-heading-art">◈</div></section>
    <SessionTimeout tr={tr} />
    {stepUpOpen && <section className="section"><MfaPanel tr={tr} reason={mfaReason} onVerified={() => { setMfaReason(''); setStepUpOpen(false); }} /></section>}
    <section className="section dashboard-app"><aside className="dash-nav">{tabs.filter(t => (isAdmin || !t.admin) && (isSuper || !t.superOnly)).map(t => <button key={t.id} className={tab === t.id ? 'dash-selected' : ''} onClick={() => setTab(t.id)}><t.icon size={18} />{t.label}</button>)}</aside>
      <div className="dash-body">
        {tab === 'overview' && <OverviewTab tr={tr} fmt={fmt} />}
        {tab === 'users' && <UsersTab tr={tr} fmt={fmt} onStepUp={stepUp} isSuper={isSuper} />}
        {tab === 'approvals' && <ApprovalsTab tr={tr} fmt={fmt} me={session.user?.id ?? ''} isSuper={isSuper} />}
        {tab === 'tickets' && <TicketsTab tr={tr} fmt={fmt} />}
        {tab === 'models' && <ModelsTab tr={tr} fmt={fmt} />}
        {tab === 'settings' && <SettingsTab tr={tr} fmt={fmt} />}
        {tab === 'incidents' && <IncidentsTab tr={tr} fmt={fmt} canEdit={isAdmin} />}
        {tab === 'audit' && (isSuper ? <AuditTab tr={tr} fmt={fmt} /> : <div className="dash-panel"><h3>{tr('سجل التدقيق', 'Audit log')}</h3><p className="muted" role="status">{tr('سجل التدقيق للمديرين الأعلى فقط.', 'The audit log is for super admins only.')}</p></div>)}
      </div></section></main>;
}

type P = { tr: (a: string, e: string) => string; fmt: (t: number) => string };

/** Arabic and English text for the approval error codes. Unknown errors show the server message. */
function apiMsg(e: unknown, tr: P['tr']): string {
  if (e instanceof ApiError) {
    const d = e.data as { message_ar?: string; message_en?: string } | undefined;
    if (e.code === 'no_second_approver') return tr(d?.message_ar ?? 'لا يوجد مدير ثانٍ للموافقة.', d?.message_en ?? e.message);
    const known = approvalCodeMessage(e.code, tr);
    if (known) return known;
  }
  return errorMessage(e);
}

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

function UsersTab({ tr, fmt, onStepUp, isSuper }: P & { onStepUp: () => void; isSuper: boolean }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [credit, setCredit] = useState<{ id: string; amount: string; note: string } | null>(null);
  const [promote, setPromote] = useState<{ id: string; email: string; role: string; reason: string; error: string } | null>(null);
  const load = useCallback(() => api<{ users: User[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`).then(r => setUsers(r.users)).catch(e => setError(errorMessage(e))), [q]);
  useEffect(() => { load(); }, [load]);
  const sent = () => setNotice(tr('أُرسل الطلب. يجب أن يوافق عليه مدير آخر خلال ٢٤ ساعة. تجده في تبويب الموافقات.', 'Request sent. Another admin must approve it within 24 hours. See the Approvals tab.'));
  const patch = async (id: string, body: object) => { try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body }); await load(); } catch (e) { setError(apiMsg(e, tr)); } };
  const isAdminLevel = (r: string) => r === 'admin' || r === 'super_admin';
  return <div className="dash-panel"><div className="panel-head"><h3>{tr('المستخدمون', 'Users')}</h3><input aria-label={tr('بحث بالبريد أو الاسم', 'Search email or name')} placeholder={tr('بحث بالبريد أو الاسم', 'Search email or name')} value={q} onChange={e => setQ(e.target.value)} /></div>
    {error && <p className="live-error" role="alert">{error}</p>}
    {notice && <p className="notice-ok" role="status">{notice}</p>}
    <div className="rows">{users.map(u => <div key={u.id} className="row-wrap"><span><b>{u.name || u.email}</b><small>{u.email} · {u.provider} · {u.emailVerified ? '✓' : tr('غير مؤكد', 'unverified')} · {fmt(u.createdAt)} · {usd(u.balanceMicroUsd, 4)}</small></span>
      <span className="row-actions">
        <select aria-label={tr('الدور', 'Role')} value={u.role} disabled={u.status === 'deleted' || (!isSuper && isAdminLevel(u.role))} onChange={e => { const role = e.target.value; if (isAdminLevel(role)) setPromote({ id: u.id, email: u.email, role, reason: '', error: '' }); else patch(u.id, { role }); }}><option>customer</option><option>support</option>{(isSuper || u.role === 'admin') && <option>admin</option>}{(isSuper || u.role === 'super_admin') && <option>super_admin</option>}</select>
        {u.status !== 'deleted' && <button className="pill-link" disabled={!isSuper && isAdminLevel(u.role)} onClick={() => { if (confirm(u.status === 'active' ? tr('إيقاف الحساب وإلغاء مفاتيحه؟', 'Suspend this account and revoke its keys?') : tr('إعادة التفعيل؟', 'Reactivate?'))) patch(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }); }}>{u.status === 'active' ? tr('فعّال', 'Active') : u.status === 'suspended' ? tr('موقوف', 'Suspended') : u.status}</button>}
        <button className="pill-link" onClick={() => setCredit({ id: u.id, amount: '', note: '' })}>{tr('رصيد', 'Credit')}</button></span>
      {credit?.id === u.id && <form className="form-row" onSubmit={async e => { e.preventDefault(); try { await api(`/api/admin/users/${u.id}/credits`, { method: 'POST', body: { amountUsd: Number(credit.amount), note: credit.note, requestKey: crypto.randomUUID() } }); setCredit(null); setError(''); sent(); await load(); } catch (err) { if (err instanceof ApiError && (err.code === 'mfa_recent_required' || err.code === 'mfa_required')) onStepUp(); else setError(apiMsg(err, tr)); } }}>
        <input type="number" step="0.01" required aria-label={tr('المبلغ بالدولار (موجب أو سالب)', 'Amount in USD (+/-)')} placeholder="USD (+/-)" value={credit.amount} onChange={e => setCredit({ ...credit, amount: e.target.value })} /><input required minLength={3} aria-label={tr('السبب', 'Reason')} placeholder={tr('السبب', 'Reason')} value={credit.note} onChange={e => setCredit({ ...credit, note: e.target.value })} /><button className="button-dark">{tr('طلب موافقة', 'Request approval')}</button><button type="button" className="link" aria-label={tr('إغلاق', 'Close')} onClick={() => setCredit(null)}>×</button></form>}</div>)}</div>
    {promote && <Dialog title={<>{tr('طلب ترقية إلى ', 'Request promotion to ')}<bdi>{promote.role}</bdi></>} onClose={() => setPromote(null)}>
      <form className="auth-form" onSubmit={async e => { e.preventDefault(); try { await api(`/api/admin/users/${promote.id}`, { method: 'PATCH', body: { role: promote.role, reason: promote.reason.trim(), requestKey: crypto.randomUUID() } }); setPromote(null); setError(''); sent(); } catch (err) { setPromote({ ...promote, error: apiMsg(err, tr) }); } }}>
        <p><bdi>{promote.email}</bdi></p>
        <label>{tr('سبب الترقية', 'Reason for the promotion')}<textarea required minLength={3} maxLength={200} value={promote.reason} onChange={e => setPromote({ ...promote, reason: e.target.value })} /></label>
        <p className="muted">{tr('لن تُطبَّق الترقية قبل موافقة مدير أعلى آخر.', 'The promotion is not applied until another super admin approves it.')}</p>
        {promote.error && <p className="live-error" role="alert">{promote.error}</p>}
        <div className="modal-actions"><button className="button-dark">{tr('إرسال الطلب', 'Send request')}</button><button type="button" className="pill-link" onClick={() => setPromote(null)}>{tr('إلغاء', 'Cancel')}</button></div></form></Dialog>}
  </div>;
}

function ApprovalsTab({ tr, fmt, me, isSuper }: P & { me: string; isSuper: boolean }) {
  const [items, setItems] = useState<Req[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<{ req: Req; action: 'approve' | 'reject' } | null>(null);
  // Typed reasons live here, not in the dialog, so a step-up (or closing with Esc) does not lose them (WCAG 3.3.7).
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [stepUp, setStepUp] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ requests: Req[] }>('/api/admin/requests').then(r => setItems(r.requests)).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const describe = (r: Req) => r.kind === 'flag_change' ? <>{tr('تشغيل الاستدلال المدفوع', 'Turn on paid inference')} (<bdi>{String(r.payload.flag)}</bdi>)</> : r.kind === 'credit_adjustment' ? <>{tr('رصيد ', 'Credit ')}<bdi>{usd((r.payload.amountUsd ?? 0) * 1e6)}</bdi>{tr(' إلى ', ' for ')}<bdi>{r.target.email}</bdi></> : <>{tr('ترقية ', 'Promote ')}<bdi>{r.target.email}</bdi>{tr(' إلى ', ' to ')}<bdi>{String(r.payload.role)}</bdi></>;
  const canApprove = (r: Req) => r.requestedBy.id !== me && r.target.id !== me && (r.kind !== 'role_change' || isSuper);
  const close = () => { setOpen(null); setStepUp(false); setDialogError(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!open) return;
    setBusy(true); setDialogError('');
    try {
      await api(`/api/admin/requests/${open.req.id}`, { method: 'POST', body: { action: open.action, reason: (reasons[open.req.id] ?? '').trim() } });
      const doneId = open.req.id;
      setReasons(old => Object.fromEntries(Object.entries(old).filter(([k]) => k !== doneId)));
      setNotice(open.action === 'approve' ? tr('تمت الموافقة وطُبّق التغيير.', 'Approved. The change was applied.') : tr('تم إنهاء الطلب.', 'The request was closed.'));
      close(); await load();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'mfa_recent_required' || err.code === 'mfa_required')) setStepUp(true);
      else { setDialogError(apiMsg(err, tr)); if (err instanceof ApiError && ['request_expired', 'request_closed', 'request_stale'].includes(err.code ?? '')) load(); }
    } finally { setBusy(false); }
  };
  const title = open ? (open.action === 'approve' ? tr('الموافقة على الطلب', 'Approve request') : open.req.requestedBy.id === me ? tr('إلغاء طلبك', 'Cancel your request') : tr('رفض الطلب', 'Reject request')) : '';
  return <div className="dash-panel"><h3>{tr('طلبات تنتظر موافقة', 'Requests waiting for approval')}</h3>
    <p className="muted">{tr('كل تعديل رصيد وكل ترقية لمدير يحتاج موافقة شخص آخر. تنتهي الطلبات بعد ٢٤ ساعة.', 'Every credit change and every promotion to admin needs a second person. Requests expire after 24 hours.')}</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    {notice && <p className="notice-ok" role="status">{notice}</p>}
    {items.length === 0 ? <p className="muted">—</p> : <div className="rows">{items.map(r => <div key={r.id} className="row-wrap"><span><b>{describe(r)}</b><small>{tr('طلب من', 'By')} <bdi>{r.requestedBy.email}</bdi> · {fmt(r.createdAt)} · {tr('ينتهي', 'expires')} {fmt(r.expiresAt)} · {r.reason}</small></span>
      <span className="row-actions">
        {canApprove(r) && <button className="pill-link" onClick={() => setOpen({ req: r, action: 'approve' })}>{tr('موافقة', 'Approve')}</button>}
        {(canApprove(r) || r.requestedBy.id === me || isSuper) && <button className="pill-link" onClick={() => setOpen({ req: r, action: 'reject' })}>{r.requestedBy.id === me ? tr('إلغاء الطلب', 'Cancel request') : tr('رفض', 'Reject')}</button>}
      </span></div>)}</div>}
    {open && <Dialog title={title} onClose={close}>
      {stepUp ? <MfaPanel tr={tr} reason={tr('للموافقة على تعديل رصيد أدخل رمزًا جديدًا (صالح ١٥ دقيقة). ما كتبته محفوظ.', 'To approve a credit change, enter a fresh code (valid for 15 minutes). What you typed is kept.')} onVerified={() => setStepUp(false)} />
      : <form className="auth-form" onSubmit={submit}>
        <dl><dt>{describe(open.req)}</dt><dd>{tr('طلب من', 'Requested by')} <bdi>{open.req.requestedBy.email}</bdi></dd><dd>{tr('السبب', 'Reason')}: {open.req.reason}</dd></dl>
        <label>{tr('سببك', 'Your reason')}<textarea required minLength={3} maxLength={200} value={reasons[open.req.id] ?? ''} onChange={e => setReasons({ ...reasons, [open.req.id]: e.target.value })} /></label>
        {dialogError && <p className="live-error" role="alert">{dialogError}</p>}
        <div className="modal-actions"><button className="button-dark" disabled={busy}>{busy ? tr('جارٍ الإرسال…', 'Sending…') : open.action === 'approve' ? tr('موافقة', 'Approve') : open.req.requestedBy.id === me ? tr('إلغاء الطلب', 'Cancel request') : tr('رفض', 'Reject')}</button><button type="button" className="pill-link" onClick={close}>{tr('إغلاق', 'Close')}</button></div></form>}
    </Dialog>}
  </div>;
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
  const save = async (body: { modelId: string; enabled: boolean; markupPercent: number | null; note: string | null }) => { try { await api('/api/admin/models', { method: 'PUT', body }); await load(); } catch (e) { setError(apiMsg(e, tr)); } };
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

function AuditTab({ tr, fmt }: P) {
  const empty = { actor: '', action: '', target: '', result: '', from: '', to: '' };
  const [form, setForm] = useState(empty);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState('');
  // true until the first load ends, so "No matching entries" and "Results: 0" never show early.
  const [busy, setBusy] = useState(true);
  const resultText = (r: AuditEvent['result']) => (r === 'denied' ? tr('مرفوض', 'Denied') : r === 'failed' ? tr('فشل', 'Failed') : r === 'success' ? tr('نجح', 'Success') : tr('قديم', 'Legacy'));
  const load = useCallback(async (f: typeof empty) => {
    const qs = new URLSearchParams({ limit: '100' });
    for (const k of ['actor', 'action', 'target', 'result'] as const) if (f[k].trim()) qs.set(k, f[k].trim());
    // Dates are the viewer's local days: from 00:00 to 23:59:59.999 of the chosen days.
    if (f.from) qs.set('from', String(new Date(`${f.from}T00:00:00`).getTime()));
    if (f.to) qs.set('to', String(new Date(`${f.to}T23:59:59.999`).getTime()));
    setBusy(true);
    try { setEvents((await api<{ events: AuditEvent[] }>(`/api/admin/audit?${qs}`)).events); setError(''); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { api<{ events: AuditEvent[] }>('/api/admin/audit?limit=100').then(r => setEvents(r.events)).catch(e => setError(errorMessage(e))).finally(() => setBusy(false)); }, []);
  const field = (id: string, label: string, el: React.ReactNode) => <label htmlFor={id} style={{ display: 'grid', gap: 4 }}>{label}{el}</label>;
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  return <div className="dash-panel"><h3>{tr('سجل التدقيق', 'Audit log')}</h3>
    <form className="auth-form" role="search" aria-label={tr('تصفية سجل التدقيق', 'Filter the audit log')} onSubmit={e => { e.preventDefault(); load(form); }}>
      {field('au-actor', tr('المنفِّذ (المعرّف أو البريد)', 'Actor (id or e-mail)'), <input id="au-actor" value={form.actor} onChange={set('actor')} maxLength={120} />)}
      {field('au-action', tr('الإجراء (جزء من الاسم)', 'Action (part of the name)'), <input id="au-action" value={form.action} onChange={set('action')} maxLength={120} />)}
      {field('au-target', tr('الهدف (المعرّف أو النوع)', 'Target (id or type)'), <input id="au-target" value={form.target} onChange={set('target')} maxLength={120} />)}
      {field('au-result', tr('النتيجة', 'Result'), <select id="au-result" value={form.result} onChange={set('result')}><option value="">{tr('الكل', 'All')}</option><option value="success">{tr('نجح', 'Success')}</option><option value="denied">{tr('مرفوض', 'Denied')}</option><option value="failed">{tr('فشل', 'Failed')}</option></select>)}
      {field('au-from', tr('من تاريخ', 'From date'), <input id="au-from" type="date" value={form.from} onChange={set('from')} />)}
      {field('au-to', tr('إلى تاريخ', 'To date'), <input id="au-to" type="date" value={form.to} onChange={set('to')} />)}
      <button className="button-dark" disabled={busy}>{busy ? tr('جارٍ التحميل…', 'Loading…') : tr('تطبيق', 'Apply')}</button>
      <button type="button" disabled={busy} onClick={() => { setForm(empty); load(empty); }}>{tr('مسح التصفية', 'Clear filters')}</button>
    </form>
    <p className="muted">{tr('الأوقات بتوقيت جهازك.', 'Times are in your local time.')}</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    <p role="status" className="muted">{busy ? tr('جارٍ التحميل…', 'Loading…') : tr(`عدد النتائج: ${events.length}`, `Results: ${events.length}`)}</p>
    <div className="rows">{events.map(e => <div key={e.id}><span><b>{e.action}</b> <span className="role-pill">{resultText(e.result)}</span>
      <small>{fmt(e.createdAt)} · {tr('المنفِّذ', 'Actor')}: <bdi>{e.actorEmail ?? e.actorId ?? '—'}</bdi>{e.actorRole ? <> (<bdi>{e.actorRole}</bdi>)</> : ''} {tr('على', 'on')} <bdi>{e.targetType ?? '—'}:{e.targetId ?? '—'}</bdi>{e.ip ? <> · <bdi>{e.ip}</bdi></> : ''}</small>
      {e.reason && <small>{tr('السبب', 'Reason')}: {e.reason}</small>}
      {(e.before != null || e.after != null) && <small dir="ltr" style={{ overflowWrap: 'anywhere' }}>{tr('قبل', 'Before')}: {JSON.stringify(e.before)} · {tr('بعد', 'After')}: {JSON.stringify(e.after)}</small>}</span></div>)}
      {!events.length && !busy && !error && <p className="muted">{tr('لا توجد سجلات مطابقة.', 'No matching entries.')}</p>}</div></div>;
}
