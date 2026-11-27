declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    /** Only the exact value "development" enables dev helpers (auth tokens echoed in API responses). */
    APP_ENV?: string;
    /** Public origin used in emails and checkout redirects, e.g. https://wasl.example */
    PUBLIC_BASE_URL?: string;
    /** Comma separated emails that become admins once their email is verified. */
    ADMIN_EMAILS?: string;
    ADMIN_EMAILS_BREAKGLASS?: string;
    /** "true" turns on the paid inference gateway. */
    INFERENCE_ENABLED?: string;
    /** Secret. Upstream provider key used by the paid gateway. */
    OPENROUTER_API_KEY?: string;
    /** Percent added on top of provider cost. Default 20. */
    DEFAULT_MARKUP_PERCENT?: string;
    /** Secret. Stripe API key. */
    STRIPE_SECRET_KEY?: string;
    /** Secret. Stripe webhook signing secret (whsec_...). */
    STRIPE_WEBHOOK_SECRET?: string;
    /** Secret. Resend API key for transactional email. */
    RESEND_API_KEY?: string;
    /** From address for transactional email, e.g. "Wasl AI <no-reply@wasl.example>". */
    EMAIL_FROM?: string;
    /** Header carrying the real client IP, set (and overwritten) by our reverse proxy. "x-real-ip" on EC2. */
    CLIENT_IP_HEADER?: string;
    /** "true" only on the ChatGPT hosting platform, which sets and sanitises oai-authenticated-* headers. */
    TRUST_CHATGPT_HEADERS?: string;
    /** Secret. Encrypts admin TOTP secrets (AES-GCM). Required in production; admin routes fail closed without it. */
    MFA_ENCRYPTION_KEY?: string;
    /** Signup bonus in USD for new accounts. Default 0. */
    SIGNUP_BONUS_USD?: string;
  }
}
