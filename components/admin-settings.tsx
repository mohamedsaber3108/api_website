'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/client-api';
import Dialog from './dialog';
import MfaPanel from './mfa';

type Flag = { key: string; envOn: boolean; keyPresent: boolean; dbEnabled: boolean | null; effective: boolean; pending: { id: string; requestedBy: string | null; createdAt: number; expiresAt: number } | null };
type Tr = (a: string, e: string) => string;

function msg(e: unknown, tr: Tr): string {
  if (e instanceof ApiError && e.code === 'no_second_approver') {
    const d = e.data as { message_ar?: string; message_en?: string } | undefined;
    return tr(d?.message_ar ?? 'لا يوجد مدير ثانٍ للموافقة.', d?.message_en ?? e.message);
  }
  return errorMessage(e);
}

/** Settings tab: feature flags. Turning off is immediate; turning on becomes a request for a second admin. */
export default function SettingsTab({ tr, fmt }: { tr: Tr; fmt: (t: number) => string }) {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<{ flag: Flag; enable: boolean } | null>(null);
  // The reason lives here so a step-up (or Esc) does not lose it (WCAG 3.3.7).
  const [reason, setReason] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ flags: Flag[] }>('/api/admin/settings').then(r => { setFlags(r.flags); setError(''); }).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const yes = (v: boolean) => (v ? tr('نعم', 'Yes') : tr('لا', 'No'));
  const close = () => { setOpen(null); setStepUp(false); setDialogError(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!open) return;
    setBusy(true); setDialogError('');
    try {
      await api('/api/admin/settings', { method: 'POST', body: { flag: open.flag.key, enabled: open.enable, reason: reason.trim(), requestKey: crypto.randomUUID() } });
      setNotice(open.enable ? tr('أُرسل طلب التشغيل. يجب أن يوافق عليه مدير آخر. تجده في تبويب الموافقات.', 'Turn-on request sent. Another admin must approve it. See the Approvals tab.') : tr('تم إيقاف الاستدلال المدفوع الآن.', 'Paid inference is now off.'));
      setReason(''); close(); await load();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'mfa_required' || err.code === 'mfa_recent_required')) setStepUp(true);
      else setDialogError(msg(err, tr));
    } finally { setBusy(false); }
  };
  return <div className="dash-panel"><h3>{tr('الإعدادات', 'Settings')}</h3>
    <p className="muted">{tr('الإيقاف فوري. التشغيل يحتاج موافقة مدير آخر. كل تغيير يُسجَّل.', 'Turning off is immediate. Turning on needs a second admin. Every change is logged.')}</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    {notice && <p className="notice-ok" role="status">{notice}</p>}
    <div className="rows">{flags.map(f => {
      const on = f.dbEnabled === true;
      const label = f.key === 'inference' ? tr('الاستدلال المدفوع (إيقاف طارئ)', 'Paid inference (emergency stop)') : f.key;
      const labelId = `flag-${f.key}`;
      return <div key={f.key} className="row-wrap"><span><b id={labelId}>{label}</b>
        <small role="status">{f.effective ? tr('الحالة الفعلية: يعمل', 'Effective: running') : tr('الحالة الفعلية: متوقف', 'Effective: stopped')}</small>
        <small>{tr('متغير INFERENCE_ENABLED مفعّل', 'INFERENCE_ENABLED is true')}: {yes(f.envOn)} · {tr('مفتاح المزوّد موجود', 'Provider key present')}: {yes(f.keyPresent)} · {tr('مفتاح الإعداد في قاعدة البيانات', 'Database switch')}: {f.dbEnabled === null ? tr('تعذّرت القراءة (يُعامل كمتوقف)', 'could not be read (treated as off)') : on ? tr('مفعّل', 'on') : tr('متوقف', 'off')}</small>
        {f.pending && <small>{tr('طلب تشغيل ينتظر موافقة من', 'Turn-on request waiting, made by')} <bdi>{f.pending.requestedBy}</bdi> · {tr('ينتهي', 'expires')} {fmt(f.pending.expiresAt)}</small>}
      </span>
      <span className="row-actions"><button type="button" role="switch" aria-checked={on} aria-labelledby={labelId} className="pill-link" disabled={!on && !!f.pending} onClick={() => { setReason(''); setOpen({ flag: f, enable: !on }); }}>{on ? tr('مفعّل: اضغط للإيقاف', 'On: press to turn off') : f.pending ? tr('بانتظار الموافقة', 'Waiting for approval') : tr('متوقف: اضغط لطلب التشغيل', 'Off: press to request turn-on')}</button></span></div>;
    })}</div>
    {open && <Dialog title={open.enable ? tr('طلب تشغيل الاستدلال المدفوع', 'Request: turn on paid inference') : tr('إيقاف الاستدلال المدفوع الآن', 'Turn off paid inference now')} onClose={close}>
      {stepUp ? <MfaPanel tr={tr} reason={tr('أدخل رمزًا جديدًا ثم أعد المحاولة. ما كتبته محفوظ.', 'Enter a fresh code, then try again. What you typed is kept.')} onVerified={() => setStepUp(false)} />
      : <form className="auth-form" onSubmit={submit}>
        <p>{open.enable ? tr('لن يعمل الاستدلال قبل موافقة مدير آخر.', 'Inference will not run until another admin approves.') : tr('سيتوقف الاستدلال وشحن الرصيد فورًا لكل العملاء.', 'Inference and top-ups stop at once for every customer.')}</p>
        <label>{tr('السبب', 'Reason')}<textarea required minLength={3} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label>
        {dialogError && <p className="live-error" role="alert">{dialogError}</p>}
        <div className="modal-actions"><button className="button-dark" disabled={busy}>{busy ? tr('جارٍ الإرسال…', 'Sending…') : open.enable ? tr('إرسال الطلب', 'Send request') : tr('إيقاف الآن', 'Turn off now')}</button><button type="button" className="pill-link" onClick={close}>{tr('إغلاق', 'Close')}</button></div></form>}
    </Dialog>}
  </div>;
}
