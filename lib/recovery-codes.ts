export const RECOVERY_FILE_NAME = 'wasl-recovery-codes.txt';

/** Plain text for copy and download: one code per line, trailing newline. */
export function recoveryCodesText(codes: string[]): string {
  return codes.map(c => c.trim()).filter(Boolean).join('\n') + '\n';
}
