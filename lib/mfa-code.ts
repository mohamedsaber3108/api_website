/** Arabic-Indic (U+0660-0669) and Persian (U+06F0-06F9) digits become 0-9; spaces are removed. Used by the server and the MFA screen so both agree. */
export function normaliseCodeInput(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s/g, '');
}
