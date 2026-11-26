/**
 * Log redaction. Everything that reaches console.* from a catch block goes through `errText`
 * so e-mail addresses, bearer tokens, API keys, auth tokens and SQL parameters never land in logs.
 * shortcut: pattern based, so a secret in an unknown format is not caught; extend PATTERNS when a new key format is added.
 */
const PATTERNS: [RegExp, string][] = [
  [/\bparams?:[\s\S]*$/gi, 'params: [redacted]'], // drizzle / D1 errors append the bound values
  [/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]'],
  [/\bwasl_[a-f0-9]{16,}/gi, '[redacted-key]'],
  [/\b[a-f0-9]{32,}\b/gi, '[redacted-token]'],
  [/\b(?:whsec|sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[redacted-key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'],
];

export function redact(text: string): string {
  return PATTERNS.reduce((s, [re, to]) => s.replace(re, to), text);
}

/** Safe text for logging an unknown thrown value. */
export function errText(e: unknown): string {
  return redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
}
