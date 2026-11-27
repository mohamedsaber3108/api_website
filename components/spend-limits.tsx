'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import { api, errorMessage, usd } from '../lib/client-api';

type Row = { limitMicroUsd: number | null; spentMicroUsd: number };
type Limits = { account: Row; keys: (Row & { id: string; name: string; prefix: string })[] };

/** Accepts Arabic-Indic and Persian digits and the Arabic decimal mark, so an Arabic keyboard works. */
export function parseLimitUsd(text: string): number | null {
  const s = text.trim().replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0)).replace(/٫/g, '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 100000 ? n : null;
}

function LimitRow({ ar, label, row, onSave }: { ar: boolean; label: string; row: Row; onSave: (limitUsd: number | null) => Promise<void> }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [text, setText] = useState(row.limitMicroUsd === null ? '' : String(row.limitMicroUsd / 1e6));
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const value = parseLimitUsd(text);
  const invalid = text.trim() !== '' && value === null;
  const save = async (value: number | null) => { setBusy(true); try { await onSave(value); } finally { setBusy(false); } };
  return <div>
    <span><b>{label}</b><small>{tr('أُنفق هذا الشهر', 'Spent this month')}: <bdi dir="ltr">{usd(row.spentMicroUsd, 4)}</bdi> · {row.limitMicroUsd === null ? tr('بلا حد', 'No limit') : <>{tr('الحد', 'Limit')}: <bdi dir="ltr">{usd(row.limitMicroUsd, 2)}</bdi></>}</small></span>
    <span className="row-actions">
      <input dir="ltr" inputMode="decimal" aria-label={`${label}: ${tr('الحد الشهري بالدولار', 'monthly limit in USD')}`} placeholder={tr('بلا حد', 'No limit')} aria-invalid={invalid} aria-describedby={invalid ? hintId : undefined} value={text} onChange={e => setText(e.target.value)} />
      <button className="button-dark" disabled={busy || value === null} onClick={() => value !== null && save(value)}>{tr('حفظ', 'Save')}</button>
      <button disabled={busy || row.limitMicroUsd === null} onClick={() => { setText(''); save(null); }}>{tr('إزالة', 'Remove')}</button>
    </span>
    {invalid && <small id={hintId} className="live-error" role="status">{tr('أدخل رقماً أكبر من 0 وحتى 100000.', 'Enter a number above 0, up to 100000.')}</small>}
  </div>;
}

/** FEAT-2: optional monthly spend limits for the account and for each key. The gateway returns 402 spend_limit_reached over a limit. */
export default function SpendLimits({ ar }: { ar: boolean }) {
  const tr = (a: string, e: string) => (ar ? a : e);
  const [data, setData] = useState<Limits | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const load = useCallback(() => api<Limits>('/api/account/limits').then(d => { setData(d); setError(''); }).catch(e => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const save = (body: { scope: 'account' | 'key'; keyId?: string }) => async (limitUsd: number | null) => {
    setError(''); setOk('');
    try { await api('/api/account/limits', { method: 'PUT', body: { ...body, limitUsd } }); setOk(tr('تم الحفظ.', 'Saved.')); await load(); } catch (e) { setError(errorMessage(e)); }
  };
  return <div className="dash-panel"><h3>{tr('حدود الإنفاق الشهرية', 'Monthly spend limits')}</h3>
    <p className="muted">{ar
      ? <>اختياري. عند بلوغ الحد يرفض النظام الطلبات الجديدة برمز <bdi dir="ltr"><code>spend_limit_reached</code></bdi> حتى بداية الشهر (<bdi dir="ltr">UTC</bdi>) أو حتى ترفع الحد. القيمة أكبر من <bdi dir="ltr">0</bdi> وحتى <bdi dir="ltr">100000</bdi> دولار.</>
      : <>Optional. At the limit, new requests are refused with code <code>spend_limit_reached</code> until the next month (UTC) or until you raise it. Allowed: above 0, up to 100000 USD.</>}</p>
    {error && <p className="live-error" role="alert">{error}</p>}{ok && <p className="auth-info" role="status">{ok}</p>}
    {data && <div className="rows">
      <LimitRow key={`a-${data.account.limitMicroUsd}`} ar={ar} label={tr('الحساب كله', 'Whole account')} row={data.account} onSave={save({ scope: 'account' })} />
      {data.keys.map(k => <LimitRow key={`${k.id}-${k.limitMicroUsd}`} ar={ar} label={`${k.name} (${k.prefix}…)`} row={k} onSave={save({ scope: 'key', keyId: k.id })} />)}
    </div>}
  </div>;
}
