export type CreditShortfall = { lead: string; need: string; mid: string; have: string; tail: string; linkLabel: string; href: string };

const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

/** Maps the gateway 402 `insufficient_credits` body to one-language text pieces. The amounts are rendered in <bdi> by the caller. */
export function creditShortfall(lang: 'ar' | 'en', needMicro: number, availableMicro: number): CreditShortfall {
  const ar = lang === 'ar';
  return {
    lead: ar ? 'رصيدك غير كافٍ لهذا الطلب. قد تصل تكلفته إلى ' : 'Your balance is too low for this request. It can cost up to ',
    need: usd(needMicro),
    mid: ar ? ' والمتاح ' : '; available ',
    have: usd(availableMicro),
    tail: '.',
    linkLabel: ar ? 'أضف رصيداً' : 'Add credit',
    href: '/dashboard',
  };
}

/** Reads the structured 402 body; returns null when the numbers are missing so the caller falls back to the message text. */
export function creditShortfallFromError(lang: 'ar' | 'en', err: { code?: unknown; need_micro_usd?: unknown; available_micro_usd?: unknown } | undefined): CreditShortfall | null {
  if (err?.code !== 'insufficient_credits' || typeof err.need_micro_usd !== 'number' || typeof err.available_micro_usd !== 'number') return null;
  return creditShortfall(lang, err.need_micro_usd, err.available_micro_usd);
}
