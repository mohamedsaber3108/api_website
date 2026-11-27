import { escapeHtml } from './email';

export type MailLang = 'ar' | 'en';
export type MailKind = 'verify_email' | 'reset_password';

/**
 * Language of a mail: the saved account preference (preferences JSON, key `lang`) first,
 * then the Accept-Language header (English only when it starts with "en"), else Arabic.
 */
export function mailLang(preferences?: string | null, request?: Request): MailLang {
  if (preferences) {
    try {
      const lang = (JSON.parse(preferences) as { lang?: unknown }).lang;
      if (lang === 'ar' || lang === 'en') return lang;
    } catch {
      // Bad JSON: fall through to the header.
    }
  }
  const header = (request?.headers.get('accept-language') || '').trim().toLowerCase();
  return header.startsWith('en') ? 'en' : 'ar';
}

const COPY = {
  verify_email: {
    en: {
      subject: 'Verify your Wasl AI email',
      hi: (n: string) => `Hi ${n},`,
      lead: 'Confirm your email to finish setting up your Wasl AI account:',
      note: 'This link expires in 48 hours. If you did not sign up, ignore this message.',
      cta: 'Confirm email',
    },
    ar: {
      subject: 'أكّد بريدك الإلكتروني في وصل',
      hi: (n: string) => `مرحبًا ${n}،`,
      lead: 'أكّد بريدك الإلكتروني لإكمال إعداد حسابك في وصل:',
      note: 'ينتهي هذا الرابط خلال 48 ساعة. إذا لم تنشئ حسابًا، تجاهل هذه الرسالة.',
      cta: 'تأكيد البريد',
    },
  },
  reset_password: {
    en: {
      subject: 'Reset your Wasl AI password',
      hi: (n: string) => `Hi ${n},`,
      lead: 'Use this link to choose a new password:',
      note: 'The link expires in 1 hour. If you did not request this, you can ignore this message.',
      cta: 'Choose a new password',
    },
    ar: {
      subject: 'إعادة تعيين كلمة مرور وصل',
      hi: (n: string) => `مرحبًا ${n}،`,
      lead: 'استخدم هذا الرابط لاختيار كلمة مرور جديدة:',
      note: 'ينتهي الرابط خلال ساعة واحدة. إذا لم تطلب ذلك، تجاهل هذه الرسالة.',
      cta: 'اختيار كلمة مرور جديدة',
    },
  },
} as const;

/**
 * Subject, plain text and HTML for one mail. Every inserted value is escaped in the HTML.
 * `link` must be absolute (built from PUBLIC_BASE_URL by the caller).
 */
export function renderMail(kind: MailKind, lang: MailLang, v: { link: string; name?: string }) {
  const c = COPY[kind][lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const align = lang === 'ar' ? 'right' : 'left';
  const text = `${v.name ? `${c.hi(v.name)}\n\n` : ''}${c.lead}\n${v.link}\n\n${c.note}`;
  const link = escapeHtml(v.link);
  const html =
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(c.subject)}</title></head>` +
    `<body dir="${dir}" style="margin:0;padding:24px;font-family:Tahoma,Arial,sans-serif;color:#111;background:#fff;text-align:${align}">` +
    `<div dir="${dir}" style="max-width:520px;margin:0 auto">` +
    (v.name ? `<p>${escapeHtml(c.hi(v.name))}</p>` : '') +
    `<p>${escapeHtml(c.lead)}</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(c.cta)}</a></p>` +
    `<p style="font-size:13px">${link}</p>` +
    `<p style="font-size:13px;color:#444">${escapeHtml(c.note)}</p>` +
    `</div></body></html>`;
  return { subject: c.subject, text, html };
}
