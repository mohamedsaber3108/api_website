"use client";

import { useState } from "react";
import { api, errorMessage } from "../lib/client-api";

type Lang = "ar" | "en";

/** Development-only test checkout. `payment` is null when the stub is not active or the session is unknown. */
export default function StubCheckout({ lang, payment }: { lang: Lang; payment: { amountMinor: number; currency: string; sessionId: string } | null }) {
  const tr = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pay() {
    if (!payment || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/billing/stub/pay", { method: "POST", body: { sessionId: payment.sessionId } });
      window.location.assign("/dashboard?tab=billing&payment=success");
    } catch (e) {
      setError(errorMessage(e, lang));
      setBusy(false);
    }
  }

  return (
    <main className="inner-page" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <section className="section auth-wrap">
        <div className="auth-card">
          {payment ? (
            <div className="auth-done">
              <h1>{tr("دفع تجريبي", "Test checkout")}</h1>
              <p>{tr("هذه صفحة تجريبية للتطوير فقط. لا يُسحب أي مبلغ حقيقي.", "This is a development-only test page. No real money is charged.")}</p>
              <p>
                {tr("المبلغ: ", "Amount: ")}
                <bdi dir="ltr">{(payment.amountMinor / 100).toFixed(2)} {payment.currency.toUpperCase()}</bdi>
              </p>
              {error && <p className="live-error" role="alert">{error}</p>}
              <button type="button" className="button-primary" onClick={pay} disabled={busy} aria-busy={busy}>
                {busy ? tr("جارٍ الدفع…", "Paying…") : tr("ادفع (تجريبي)", "Pay (test)")}
              </button>
            </div>
          ) : (
            <div className="auth-done">
              <h1>{tr("غير متاح", "Not available")}</h1>
              <p role="status">{tr("صفحة الدفع التجريبي غير متاحة.", "The test checkout page is not available.")}</p>
              <button type="button" className="pill-link" onClick={() => window.location.assign("/dashboard?tab=billing")}>{tr("العودة إلى الفوترة", "Back to billing")}</button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
