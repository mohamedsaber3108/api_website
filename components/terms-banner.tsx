'use client';
import { useState } from 'react';
import { api, errorMessage } from '../lib/client-api';

/** Persistent, non-blocking notice shown while the signed-in user's accepted terms version is older than the current one. */
export default function TermsBanner({ lang, onReview, onAccepted }: { lang: 'ar' | 'en'; onReview: () => void; onAccepted: () => void }) {
  const ar = lang === 'ar';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/accept-terms', { method: 'POST', body: {} });
      onAccepted();
    } catch (e) {
      setError(errorMessage(e, lang));
      setBusy(false);
    }
  }
  return (
    <section className="terms-banner" role="region" aria-labelledby="terms-banner-text" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'center', padding: '10px 16px', background: 'var(--surface, #fff8e1)', borderBottom: '1px solid currentColor' }}>
      <span id="terms-banner-text">{ar ? 'تم تحديث شروطنا. يرجى مراجعتها والموافقة للمتابعة.' : 'Our terms were updated. Please review and accept to continue.'}</span>
      <button type="button" className="pill-link" onClick={onReview}>{ar ? 'مراجعة الشروط' : 'Review terms'}</button>
      <button type="button" className="button-primary" disabled={busy} onClick={accept}>{ar ? 'أوافق' : 'Accept'}</button>
      {error && <span role="alert">{error}</span>}
    </section>
  );
}
