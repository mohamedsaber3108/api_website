'use client';
import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight } from 'lucide-react';
import { openIncidentsHeadline } from '../lib/status-headline';

type Lang = 'ar' | 'en';
type Incident = { id: string; title: string; body: string; status: string; severity: string; createdAt: number; resolvedAt: number | null; open?: boolean };
type Report = {
  status: 'operational' | 'degraded';
  checkedAt: string;
  checks: { database: string; inference: string; billing: string; email: string };
  incidents: Incident[];
};

const VALUE: Record<string, { ar: string; en: string; ok: boolean }> = {
  ok: { ar: 'يعمل', en: 'Working', ok: true },
  down: { ar: 'متوقف', en: 'Down', ok: false },
  on: { ar: 'مفعّل', en: 'On', ok: true },
  off: { ar: 'متوقف', en: 'Off', ok: false },
  configured: { ar: 'مُعدّ', en: 'Configured', ok: true },
  not_configured: { ar: 'غير مُعدّ', en: 'Not configured', ok: false },
};
const INCIDENT_STATUS: Record<string, { ar: string; en: string }> = {
  investigating: { ar: 'قيد الفحص', en: 'Investigating' },
  identified: { ar: 'تم تحديد السبب', en: 'Identified' },
  monitoring: { ar: 'قيد المراقبة', en: 'Monitoring' },
  resolved: { ar: 'تم الحل', en: 'Resolved' },
};
const SEVERITY: Record<string, { ar: string; en: string }> = {
  minor: { ar: 'بسيط', en: 'Minor' },
  major: { ar: 'كبير', en: 'Major' },
  critical: { ar: 'حرج', en: 'Critical' },
};

export function StatusCenter({ lang }: { lang: Lang }) {
  const ar = lang === 'ar';
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/v1/status')
        .then(r => r.json() as Promise<Report>)
        .then(v => { if (alive) { setReport(v); setFailed(false); } })
        .catch(() => { if (alive) setFailed(true); });
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const open = (report?.incidents ?? []).filter(i => (i.open ?? i.resolvedAt == null));
  const headline = failed || (report && report.status === 'degraded')
    ? (ar ? 'تشغيل جزئي أو تعذّر الفحص' : 'Partial disruption or check failed')
    : !report
      ? (ar ? 'جارٍ التحقق' : 'Checking')
      : openIncidentsHeadline(open.length, lang);
  const rows: [keyof Report['checks'], string][] = [
    ['database', ar ? 'قاعدة البيانات' : 'Database'],
    ['inference', ar ? 'استدلال وصل (مفتاح التشغيل)' : 'Wasl inference (switch)'],
    ['billing', ar ? 'الفوترة' : 'Billing'],
    ['email', ar ? 'البريد' : 'Email'],
  ];
  const fmt = (ms: number) => new Date(ms).toLocaleString(ar ? 'ar-EG' : 'en-US');

  return (
    <main className="inner-page">
      <section className="page-heading section">
        <span className="section-kicker" lang="en">WASL / STATUS</span>
        <h1>{ar ? 'حالة مكوّنات وصل.' : 'Wasl service status.'}</h1>
        <p>{ar ? 'فحص مباشر لقاعدة البيانات والخدمات، مع سجل الحوادث.' : 'Live checks of the database and services, with incident history.'}</p>
        <div className="page-heading-art"><Activity /></div>
      </section>
      <section className="section status-grid">
        <div className="status-live" role="status" aria-live="polite">
          <span className="live-dot" />
          <strong>{headline}</strong>
        </div>
        <p className="muted">
          {ar ? 'آخر فحص: ' : 'Last checked: '}
          {report ? fmt(Date.parse(report.checkedAt)) : '…'}
        </p>
        {rows.map(([key, label]) => {
          const raw = report?.checks?.[key];
          const v = raw ? VALUE[raw] : undefined;
          return (
            <div className="status-row" key={key}>
              <span>{label}</span>
              <strong className={v?.ok ? 'ready' : 'pending'}>{v ? (ar ? v.ar : v.en) : '…'}</strong>
            </div>
          );
        })}
        <h3>{ar ? 'الحوادث' : 'Incidents'}</h3>
        {report && report.incidents.length === 0 ? (
          <p className="muted">{ar ? 'لا توجد حوادث مفتوحة أو حديثة.' : 'No open or recent incidents.'}</p>
        ) : (
          (report?.incidents ?? []).map(i => (
            <div className="status-row" key={i.id}>
              <span>
                <b dir="auto">{i.title}</b>
                <br />
                <small>
                  {ar ? 'بدأ: ' : 'Started: '}{fmt(i.createdAt)}
                  {i.resolvedAt ? ` · ${ar ? 'انتهى: ' : 'Resolved: '}${fmt(i.resolvedAt)}` : ''}
                  {' · '}{(SEVERITY[i.severity] ?? { ar: i.severity, en: i.severity })[lang]}
                </small>
                <br />
                <small dir="auto">{i.body}</small>
              </span>
              <strong className={i.status === 'resolved' ? 'ready' : 'pending'}>{(INCIDENT_STATUS[i.status] ?? { ar: i.status, en: i.status })[lang]}</strong>
            </div>
          ))
        )}
        <a className="pill-link" href="/api/v1/status" target="_blank" rel="noopener noreferrer">
          {ar ? 'افتح API الحالة' : 'Open status API'} <ArrowUpRight size={15} />
        </a>
      </section>
    </main>
  );
}
