'use client';
import { useId } from 'react';
import Dialog from './dialog';

/**
 * Confirmation in the page language, replacing the browser confirm() (UX-A5).
 * Built on the shared Dialog: focus moves in (to Cancel, the safe choice), Tab stays inside, Esc cancels, focus returns.
 * Callers pass text already translated.
 */
export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: { title: React.ReactNode; message: React.ReactNode; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const msg = useId();
  return <Dialog title={title} alert describedBy={msg} onClose={onCancel}>
    <p id={msg} className="muted">{message}</p>
    <div className="modal-actions"><button type="button" className="pill-link" onClick={onCancel}>{cancelLabel}</button><button type="button" className="button-dark" onClick={onConfirm}>{confirmLabel}</button></div></Dialog>;
}
