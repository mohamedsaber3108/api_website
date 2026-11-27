'use client';
import { useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/client-api';
import { LEGAL_VERSIONS } from '../lib/legal-versions';

/** Persistent, non-blocking notice shown while the signed-in user has not accepted the current terms version. */
export default function TermsBanner({ lang, never, version, onReview, onAccepted }: { lang: 'ar' | 'en'; never: boolean; version: string; onReview: () => void; onAccepted: () => void }) {
  const ar = lang === 'ar';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/accept-terms', { method: 'POST', body: { version } });
      onAccepted();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { onAccepted(); return; }
      setError(errorMessage(e, lang));
      setBusy(false);
    }
  }
  const text = never
    ? (ar ? 'يرجى مراجعة شروطنا والموافقة عليها.' : 'Please review and accept our terms.')
    : (ar ? 'تم تحديث شروطنا. يرجى مراجعتها والموافقة عليها.' : 'Our terms were updated. Please review and accept them.');
  const changes = never ? undefined : LEGAL_VERSIONS.terms.changes?.[lang];
  return (
    <section className="terms-banner" aria-labelledby="terms-banner-text" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'center', padding: '10px 16px', background: 'var(--surface-alt)', color: 'var(--ink)', borderBottom: '1px solid var(--line)' }}>
      <span id="terms-banner-text">{text}</span>
      {changes && <span>{changes}</span>}
      <button type="button" className="pill-link" onClick={onReview}>{ar ? 'مراجعة الشروط' : 'Review terms'}</button>
      <button type="button" className="button-primary" disabled={busy} aria-busy={busy} onClick={accept}>{busy ? (ar ? 'جارٍ الحفظ…' : 'Saving…') : (ar ? 'أوافق' : 'Accept')}</button>
      {error && <span role="alert">{error}</span>}
    </section>
  );
}
