'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, LockKeyhole, Mail, UserPlus } from 'lucide-react';
import { api, errorMessage, type SessionInfo } from '../lib/client-api';

export type AuthMode = 'login' | 'register' | 'forgot-password' | 'reset-password' | 'verify-email';
type Props = { mode: AuthMode; lang: 'ar' | 'en'; session: SessionInfo | null; go: (page: AuthMode | 'dashboard' | 'terms' | 'privacy') => void; onChanged: () => Promise<void> | void };

export default function AuthPage({ mode, lang, session, go, onChanged }: Props) {
  const ar = lang === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const [form, setForm] = useState({ name: '', email: '', password: '', accept: false });
  // Auth pages only render after client-side routing, so reading the URL during render is safe.
  const token = typeof window === 'undefined' ? '' : new URLSearchParams(location.search).get('token') || '';
  const [busy, setBusy] = useState(mode === 'verify-email' && !!token);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [devToken, setDevToken] = useState('');

  useEffect(() => {
    if (mode !== 'verify-email' || !token) return;
    api('/api/auth/verify-email', { method: 'POST', body: { token } })
      .then(async () => { setInfo(tr('تم تأكيد بريدك الإلكتروني.', 'Your email is verified.')); await onChanged(); })
      .catch(e => setError(errorMessage(e)))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setInfo(''); setDevToken('');
    try {
      if (mode === 'login') {
        await api('/api/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
        await onChanged(); go('dashboard');
      } else if (mode === 'register') {
        const r = await api<{ dev_verify_token?: string }>('/api/auth/register', { method: 'POST', body: { email: form.email, password: form.password, name: form.name, acceptTerms: form.accept } });
        await onChanged();
        if (r.dev_verify_token) setDevToken(r.dev_verify_token); else go('dashboard');
      } else if (mode === 'forgot-password') {
        const r = await api<{ dev_reset_token?: string }>('/api/auth/forgot-password', { method: 'POST', body: { email: form.email } });
        setInfo(tr('إذا كان البريد مسجلًا فسنرسل رابط إعادة التعيين.', 'If that email has an account, a reset link is on its way.'));
        if (r.dev_reset_token) setDevToken(r.dev_reset_token);
      } else if (mode === 'reset-password') {
        await api('/api/auth/reset-password', { method: 'POST', body: { token, password: form.password } });
        setInfo(tr('تم تغيير كلمة المرور. سجّل الدخول بها الآن.', 'Password changed. You can sign in now.'));
      }
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const titles: Record<AuthMode, [string, string]> = {
    login: ['أهلًا بعودتك.', 'Welcome back.'],
    register: ['أنشئ حساب مطوّر.', 'Create your developer account.'],
    'forgot-password': ['استعد كلمة المرور.', 'Reset your password.'],
    'reset-password': ['اختر كلمة مرور جديدة.', 'Choose a new password.'],
    'verify-email': ['تأكيد البريد الإلكتروني.', 'Verify your email.'],
  };
  const Icon = mode === 'register' ? UserPlus : mode === 'verify-email' ? Mail : LockKeyhole;
  const alreadyIn = session?.user && (mode === 'login' || mode === 'register');

  return <main className="inner-page"><section className="page-heading section"><span className="section-kicker">WASL / ACCOUNT</span><h1>{tr(...titles[mode])}</h1><div className="page-heading-art"><Icon /></div></section>
    <section className="section auth-wrap"><div className="auth-card">
      {alreadyIn ? <div className="auth-done"><CheckCircle2 size={26} /><p>{tr('أنت مسجّل الدخول بالفعل.', 'You are already signed in.')}</p><button className="button-primary" onClick={() => go('dashboard')}>{tr('افتح لوحة التحكم', 'Open dashboard')}</button></div>
      : mode === 'verify-email' ? <div className="auth-done">{busy && <p>{tr('جارٍ التحقق…', 'Verifying…')}</p>}{!token && <p className="live-error">{tr('رابط غير صالح.', 'Invalid link.')}</p>}{info && <><CheckCircle2 size={26} /><p>{info}</p><button className="button-primary" onClick={() => go('dashboard')}>{tr('لوحة التحكم', 'Dashboard')}</button></>}{error && <p className="live-error" role="alert">{error}</p>}</div>
      : devToken && mode === 'register' ? <div className="auth-done"><CheckCircle2 size={26} /><p>{tr('تم إنشاء الحساب. وضع التطوير: لم يُرسل بريد، استخدم هذا الرابط للتأكيد.', 'Account created. Dev mode: no email was sent, use this link to verify.')}</p><a className="pill-link" href={`/verify-email?token=${devToken}`}>/verify-email?token=…</a></div>
      : info && mode === 'reset-password' ? <div className="auth-done"><CheckCircle2 size={26} /><p>{info}</p><button className="button-primary" onClick={() => go('login')}>{tr('تسجيل الدخول', 'Sign in')}</button></div>
      : <form onSubmit={submit} className="auth-form">
        {mode === 'register' && <label>{tr('الاسم', 'Name')}<input required minLength={2} maxLength={80} autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>}
        {mode !== 'reset-password' && <label>{tr('البريد الإلكتروني', 'Email')}<input required type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>}
        {mode !== 'forgot-password' && <label>{mode === 'reset-password' ? tr('كلمة المرور الجديدة', 'New password') : tr('كلمة المرور', 'Password')}<input required type="password" minLength={mode === 'login' ? 1 : 10} maxLength={200} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />{mode !== 'login' && <small>{tr('10 أحرف على الأقل.', 'At least 10 characters.')}</small>}</label>}
        {mode === 'register' && <label className="auth-check"><input type="checkbox" required checked={form.accept} onChange={e => setForm({ ...form, accept: e.target.checked })} /><span>{tr('أوافق على ', 'I agree to the ')}<button type="button" className="link" onClick={() => go('terms')}>{tr('شروط الخدمة', 'Terms of Service')}</button>{tr(' و', ' and ')}<button type="button" className="link" onClick={() => go('privacy')}>{tr('سياسة الخصوصية', 'Privacy Policy')}</button></span></label>}
        {error && <p className="live-error" role="alert">{error}</p>}
        {info && <p className="auth-info" role="status">{info}</p>}
        {devToken && mode === 'forgot-password' && <a className="pill-link" href={`/reset-password?token=${devToken}`}>{tr('وضع التطوير: افتح رابط إعادة التعيين', 'Dev mode: open the reset link')}</a>}
        <button className="button-primary" disabled={busy}>{busy ? '…' : mode === 'login' ? tr('تسجيل الدخول', 'Sign in') : mode === 'register' ? tr('إنشاء الحساب', 'Create account') : mode === 'forgot-password' ? tr('أرسل الرابط', 'Send reset link') : tr('حفظ كلمة المرور', 'Save password')}</button>
        <div className="auth-links">
          {mode === 'login' && <><button type="button" onClick={() => go('forgot-password')}>{tr('نسيت كلمة المرور؟', 'Forgot password?')}</button><button type="button" onClick={() => go('register')}>{tr('إنشاء حساب جديد', 'Create an account')}</button></>}
          {mode === 'register' && <button type="button" onClick={() => go('login')}>{tr('لدي حساب بالفعل', 'I already have an account')}</button>}
          {(mode === 'forgot-password' || mode === 'reset-password') && <button type="button" onClick={() => go('login')}>{tr('العودة لتسجيل الدخول', 'Back to sign in')}</button>}
        </div>
        {/* Hosting-platform route outside the app router: needs a full page load, not <Link>. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        {mode === 'login' && session?.features.chatgpt && <a className="auth-chatgpt" href="/signin-with-chatgpt?return_to=%2Fdashboard" target="_top">{tr('أو سجّل الدخول عبر ChatGPT', 'Or sign in with ChatGPT')}</a>}
      </form>}
    </div></section></main>;
}
