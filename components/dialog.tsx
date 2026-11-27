'use client';
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: focus moves in on open and returns on close, Tab and Shift+Tab stay inside, Esc closes.
 * A click outside does not close it unless `closeOnBackdrop` is set (use that for read-only sheets, not for forms), so typed text is not lost by accident.
 * Layout uses logical properties, so it works in RTL.
 * `alert` makes it an alertdialog (for a time-out warning) and `describedBy` names the element that holds its message.
 * Without `title`, pass `label` (the accessible name) and render your own heading; `cardClass` and `backdropClass` keep an existing look.
 */
export default function Dialog({ title, label, onClose, children, alert = false, describedBy, cardClass = 'modal-card', backdropClass = 'modal-backdrop', closeOnBackdrop = false }: { title?: React.ReactNode; label?: string; onClose: () => void; children: React.ReactNode; alert?: boolean; describedBy?: string; cardClass?: string; backdropClass?: string; closeOnBackdrop?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('textarea,input,select') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || !box.current.contains(active))) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && (active === lastEl || !box.current.contains(active))) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus?.(); };
  }, []);
  return <div className={backdropClass} onMouseDown={closeOnBackdrop ? e => { if (e.target === e.currentTarget) close.current(); } : undefined}><div className={cardClass} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label} aria-describedby={describedBy} ref={box} tabIndex={-1}>
    {title && <h3 id={titleId}>{title}</h3>}{children}</div></div>;
}
