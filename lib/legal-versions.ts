/**
 * One source of truth for legal versions. No server imports, so both the server and the client can use it.
 * Versions are ISO dates, so a plain string compare says which is newer.
 * To publish a new version of a page, change its `version` and `effective` here. Raising `terms` makes every
 * signed-in user with an older accepted version see the re-accept banner.
 */
export type LegalPageId = 'terms' | 'privacy' | 'refund' | 'acceptable-use';

export const LEGAL_VERSIONS: Record<LegalPageId, { version: string; effective: string }> = {
  terms: { version: '2026-10-01', effective: '2026-10-01' },
  privacy: { version: '2026-10-01', effective: '2026-10-01' },
  refund: { version: '2026-10-01', effective: '2026-10-01' },
  'acceptable-use': { version: '2026-10-01', effective: '2026-10-01' },
};

/** The version a user accepts at sign-up and must re-accept when it changes. */
export const TERMS_VERSION = LEGAL_VERSIONS.terms.version;

/** True when the user never recorded a version, or recorded an older one than the current terms. */
export function termsUpdateRequired(accepted: string | null | undefined): boolean {
  return !accepted || accepted < TERMS_VERSION;
}
