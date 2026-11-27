'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, type SessionInfo, type SessionLimits } from '../lib/client-api';
import Dialog from './dialog';

type Tr = (a: string, e: string) => string;
type Mark = { idleEndsAt: number; absoluteEndsAt: number; skew: number };

const WARN_MS = 2 * 60 * 1000;
const POLL_MS = 30_000;

/** `skew` = server clock minus browser clock, so a wrong device clock does not move the warning. */
const toMark = (l: SessionLimits): Mark => ({ idleEndsAt: l.idleEndsAt, absoluteEndsAt: l.absoluteEndsAt, skew: l.now - Date.now() });
const goLogin = () => window.location.assign('/login');

/**
 * Staff session time-out (SEC-3b, WCAG 2.2.1). Asks the server every 30 s with ?peek=1 (that does not count as activity).
 * Two minutes before the end it opens a dialog. Idle end: "Stay signed in" (Esc does the same) or "Sign out".
 * Absolute end (8 h after sign-in): it cannot be extended, so the dialog only has OK.
 * The message shows the end time, not a running countdown, so a screen reader is not interrupted every second.
 * When the time is up it asks the server again; if the session is gone it opens the sign-in page (a full page load reads the session again).
 */
export default function SessionTimeout({ tr }: { tr: Tr }) {
  const [mark, setMark] = useState<Mark | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hiddenFor, setHiddenFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checking = useRef(false);
  const descId = useId();

  const peek = useCallback(async () => {
    try {
      const s = await api<SessionInfo>('/api/auth/session?peek=1');
      if (!s.user) { goLogin(); return; }
      setMark(s.sessionLimits ? toMark(s.sessionLimits) : null);
    } catch {
      // Network error: keep what we know and try again at the next poll.
    }
  }, []);

  useEffect(() => {
    peek();
    const id = setInterval(peek, POLL_MS);
    return () => clearInterval(id);
  }, [peek]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const end = mark ? Math.min(mark.idleEndsAt, mark.absoluteEndsAt) : null;
  const left = mark && end !== null ? end - (now + mark.skew) : null;
  // Once the idle limit would end after the absolute one, extending cannot help.
  const absolute = !!mark && mark.absoluteEndsAt <= mark.idleEndsAt;

  useEffect(() => {
    if (left === null || left > 0 || checking.current) return;
    checking.current = true;
    peek().finally(() => { setTimeout(() => { checking.current = false; }, 5000); });
  }, [left, peek]);

  const stay = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ sessionLimits?: SessionLimits }>('/api/auth/session', { method: 'POST', body: {} });
      if (r.sessionLimits) setMark(toMark(r.sessionLimits));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) goLogin();
      else setError(tr('تعذّر تمديد الجلسة. حاول مرة أخرى.', 'Could not extend the session. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  const signOut = () => { api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}).finally(goLogin); };

  if (!mark || end === null || left === null || left <= 0 || left > WARN_MS) return null;
  if (absolute && hiddenFor === mark.absoluteEndsAt) return null;
  const when = new Date(end).toLocaleTimeString(tr('ar-EG', 'en-US'), { timeStyle: 'short' });
  return <Dialog alert describedBy={descId}
    title={absolute ? tr('ستنتهي جلستك قريبًا', 'Your session is ending soon') : tr('هل ما زلت هنا؟', 'Are you still there?')}
    onClose={absolute ? () => setHiddenFor(mark.absoluteEndsAt) : stay}>
    <p id={descId}>{absolute
      ? <>{tr('الحد الأقصى لجلسة الإدارة ٨ ساعات ولا يمكن تمديده. ستنتهي جلستك عند ', 'An admin session lasts at most 8 hours and cannot be extended. Your session ends at ')}<bdi>{when}</bdi>{tr('. احفظ عملك ثم سجّل الدخول من جديد.', '. Save your work, then sign in again.')}</>
      : <>{tr('ستنتهي جلستك عند ', 'Your session ends at ')}<bdi>{when}</bdi>{tr(' لعدم النشاط. اختر البقاء لمتابعة العمل.', ' because of no activity. Choose to stay signed in to keep working.')}</>}</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    <div className="modal-actions">
      {absolute
        ? <button type="button" className="button-dark" onClick={() => setHiddenFor(mark.absoluteEndsAt)}>{tr('حسنًا', 'OK')}</button>
        : <><button type="button" className="button-dark" disabled={busy} onClick={stay}>{tr('ابقَ مسجّلًا', 'Stay signed in')}</button>
          <button type="button" className="pill-link" onClick={signOut}>{tr('تسجيل الخروج', 'Sign out')}</button></>}
    </div>
  </Dialog>;
}
