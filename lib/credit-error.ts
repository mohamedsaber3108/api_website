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
export function creditShortfallFromError(lang: 'ar' | 'en', err: { code?: unknown; need_micro_usd?: unknown; available_micro_usd?: unknown; limit_micro_usd?: unknown; used_micro_usd?: unknown; limit_is_key?: unknown } | undefined): CreditShortfall | null {
  if (err?.code === 'spend_limit_reached') {
    if (typeof err.limit_micro_usd !== 'number' || typeof err.used_micro_usd !== 'number') return null;
    return spendLimitShortfall(lang, err.limit_is_key === 1, err.limit_micro_usd, err.used_micro_usd);
  }
  if (err?.code !== 'insufficient_credits' || typeof err.need_micro_usd !== 'number' || typeof err.available_micro_usd !== 'number') return null;
  return creditShortfall(lang, err.need_micro_usd, err.available_micro_usd);
}

/** FEAT-2: the 402 spend_limit_reached body as one-language pieces (the server message carries both languages for API clients). */
export function spendLimitShortfall(lang: 'ar' | 'en', isKey: boolean, limitMicro: number, usedMicro: number): CreditShortfall {
  const ar = lang === 'ar';
  return {
    lead: ar ? (isKey ? 'تم بلوغ حد الإنفاق الشهري لهذا المفتاح. الحد ' : 'تم بلوغ حد الإنفاق الشهري لحسابك. الحد ') : isKey ? 'Monthly spend limit reached for this API key. Limit ' : 'Monthly spend limit reached for your account. Limit ',
    need: usd(limitMicro),
    mid: ar ? '، المستخدم أو المحجوز هذا الشهر ' : '; used or reserved this month ',
    have: usd(usedMicro),
    tail: '.',
    linkLabel: ar ? 'غيّر الحد' : 'Change the limit',
    href: '/dashboard',
  };
}
