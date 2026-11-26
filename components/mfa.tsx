'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { normaliseCodeInput } from '../lib/mfa-code';
import { api, ApiError, errorMessage } from '../lib/client-api';

type Tr = (a: string, e: string) => string;
type Status = { enrolled: boolean; pending: boolean; verified: boolean; recent: boolean };

/** Arabic and English text for the MFA error codes; unknown errors fall back to the server message. */
function mfaError(e: unknown, tr: Tr): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_mfa_code') return tr('الرمز غير صحيح. جرّب رمزًا جديدًا.', 'Incorrect code. Try a new one.');
    if (e.code === 'mfa_locked') return tr('محاولات خاطئة كثيرة. تم إيقاف التحقق لهذا الحساب لمدة ١٥ دقيقة.', 'Too many wrong codes. MFA is locked for this account for 15 minutes.');
    if (e.code === 'mfa_not_configured') return tr('التحقق بخطوتين غير مهيّأ على الخادم. اتصل بمسؤول الخادم.', 'MFA is not configured on the server. Contact the server operator.');
    if (e.code === 'mfa_already_enrolled') return tr('التحقق بخطوتين مفعّل بالفعل.', 'MFA is already set up.');
  }
  return errorMessage(e);
}

/**
 * Admin MFA screen: enrol (text secret + otpauth link, no QR), or enter a code (step-up).
 * Calls onVerified once the session is MFA verified. `reason` explains why it appeared.
 */
export default function MfaPanel({ tr, onVerified, reason }: { tr: Tr; onVerified: () => void; reason?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api<Status>('/api/auth/mfa/status').then(setStatus).catch(e => setError(mfaError(e, tr)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = async () => {
    setBusy(true); setError('');
    try { setSetup(await api('/api/auth/mfa/begin', { method: 'POST', body: {} })); } catch (e) { setError(mfaError(e, tr)); } finally { setBusy(false); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (status?.enrolled) { await api('/api/auth/mfa/verify', { method: 'POST', body: { code: normaliseCodeInput(code) } }); onVerified(); }
      else { const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/confirm', { method: 'POST', body: { code: normaliseCodeInput(code) } }); setCodes(r.recoveryCodes); }
    } catch (err) { setError(mfaError(err, tr)); } finally { setBusy(false); setCode(''); }
  };

  const shell = (children: React.ReactNode) => <div className="auth-wrap"><div className="auth-card"><div className="auth-form"><h2><ShieldCheck size={22} aria-hidden="true" /> {tr('التحقق بخطوتين للإدارة', 'Admin two-step verification')}</h2>{reason && <p className="auth-info" role="status">{reason}</p>}{children}</div></div></div>;

  if (codes) return shell(<>
    <p>{tr('احفظ رموز الاسترداد هذه الآن. تظهر مرة واحدة فقط، وكل رمز يُستخدم مرة واحدة.', 'Save these recovery codes now. They are shown once and each works once.')}</p>
    <textarea readOnly dir="ltr" aria-label={tr('رموز الاسترداد', 'Recovery codes')} rows={10} value={codes.join('\n')} onFocus={e => e.currentTarget.select()} />
    <button className="button-primary" onClick={onVerified}><CheckCircle2 size={18} aria-hidden="true" /> {tr('حفظتها، تابع', 'I saved them, continue')}</button>
  </>);

  if (!status) return shell(error ? <p className="live-error" role="alert">{error}</p> : <p className="muted" role="status">{tr('جارٍ التحميل…', 'Loading…')}</p>);

  if (!status.enrolled && !setup) return shell(<>
    <p>{tr('حسابك إداري، ويلزم تفعيل التحقق بخطوتين قبل فتح لوحة الإدارة. ستحتاج تطبيق مصادقة على هاتفك.', 'Your account is an admin account. Set up two-step verification before the admin area opens. You need an authenticator app on your phone.')}</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    <button className="button-primary" disabled={busy} onClick={begin}>{busy ? tr('جارٍ التحضير…', 'Preparing…') : tr('ابدأ الإعداد', 'Start setup')}</button>
  </>);

  return <form onSubmit={submit} className="auth-wrap"><div className="auth-card"><div className="auth-form">
    <h2><ShieldCheck size={22} aria-hidden="true" /> {tr('التحقق بخطوتين للإدارة', 'Admin two-step verification')}</h2>
    {reason && <p className="auth-info" role="status">{reason}</p>}
    {!status.enrolled && setup && <>
      <p>{tr('أضف هذا المفتاح في تطبيق المصادقة (إضافة حساب يدويًا)، أو افتح الرابط على هاتفك. يمكنك نسخه ولصقه.', 'Add this key in your authenticator app (enter a setup key), or open the link on your phone. You can copy and paste it.')}</p>
      <label>{tr('مفتاح الإعداد', 'Setup key')}<input readOnly dir="ltr" value={setup.secret} onFocus={e => e.currentTarget.select()} /></label>
      <a className="pill-link" dir="ltr" href={setup.otpauthUrl}>{tr('افتح في تطبيق المصادقة', 'Open in authenticator app')}</a>
    </>}
    <label>{status.enrolled ? tr('رمز التحقق (٦ أرقام) أو رمز استرداد', 'Verification code (6 digits) or a recovery code') : tr('الرمز المكوّن من ٦ أرقام', '6-digit code')}
      <input required dir="ltr" inputMode={status.enrolled ? 'text' : 'numeric'} autoComplete="one-time-code" autoFocus minLength={6} maxLength={20} value={code} onChange={e => setCode(e.target.value)} />
    </label>
    {error && <p className="live-error" role="alert">{error}</p>}
    <button className="button-primary" disabled={busy}>{busy ? tr('جارٍ التحقق…', 'Verifying…') : status.enrolled ? tr('تحقق', 'Verify') : tr('تأكيد وتفعيل', 'Confirm and enable')}</button>
  </div></div></form>;
}
