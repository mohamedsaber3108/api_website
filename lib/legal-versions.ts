/**
 * One source of truth for legal versions. No server imports, so both the server and the client can use it.
 * Versions are ISO dates, so a plain string compare says which is newer.
 *
 * To publish a new version of a page:
 *  1. Archive the old text: copy the full current AR and EN text of the page into LEGAL_ARCHIVE
 *     in components/legal.tsx, under the old version id.
 *  2. Add a NEW entry at the TOP of that page's list in LEGAL_HISTORY below (newest first), with
 *     `version`, `effective`, and `changes: { ar, en }`. The owner writes the `changes` summary.
 *  3. Edit the live text of the page in `docs` in components/legal.tsx.
 * Raising `terms` makes every signed-in user with an older accepted version see the re-accept banner,
 * with the `changes` summary of the newest terms entry.
 */
export type LegalPageId = 'terms' | 'privacy' | 'refund' | 'acceptable-use';

export type LegalEntry = { version: string; effective: string; changes?: { ar: string; en: string } };

/** Per page, newest first. Only one entry per page today. */
export const LEGAL_HISTORY: Record<LegalPageId, LegalEntry[]> = {
  terms: [{ version: '2026-10-01', effective: '2026-10-01' }],
  privacy: [{ version: '2026-10-01', effective: '2026-10-01' }],
  refund: [{ version: '2026-10-01', effective: '2026-10-01' }],
  'acceptable-use': [{ version: '2026-10-01', effective: '2026-10-01' }],
};

/** The current entry of each page (the first of its history). */
export const LEGAL_VERSIONS: Record<LegalPageId, LegalEntry> = {
  terms: LEGAL_HISTORY.terms[0],
  privacy: LEGAL_HISTORY.privacy[0],
  refund: LEGAL_HISTORY.refund[0],
  'acceptable-use': LEGAL_HISTORY['acceptable-use'][0],
};

/** The version a user accepts at sign-up and must re-accept when it changes. */
export const TERMS_VERSION = LEGAL_VERSIONS.terms.version;

/** The history entry of a page for a version id, or undefined when unknown. */
export function findLegalVersion(page: LegalPageId, v: string): LegalEntry | undefined {
  return LEGAL_HISTORY[page].find(e => e.version === v);
}

/** True when the user never recorded a version, or recorded an older one than the current terms. */
export function termsUpdateRequired(accepted: string | null | undefined): boolean {
  return !accepted || accepted < TERMS_VERSION;
}
