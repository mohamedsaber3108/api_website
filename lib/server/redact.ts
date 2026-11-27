/**
 * Smallest local redaction for text that is stored or logged (e-mail, bearer, sk-, whsec_, long hex).
 * shortcut: PR 4 has the fuller helper; when PR 4 merges, switch callers to it and delete this file.
 */
export function redactText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]');
}
