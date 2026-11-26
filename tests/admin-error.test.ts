import { describe, expect, it } from 'vitest';
import { approvalCodeMessage } from '../lib/admin-error';

describe('approval error codes', () => {
  it('request_stale and target_inactive give one language each', () => {
    for (const code of ['request_stale', 'target_inactive']) {
      const ar = approvalCodeMessage(code, (a) => a) as string;
      const en = approvalCodeMessage(code, (_a, e) => e) as string;
      expect(ar).not.toMatch(/[A-Za-z]/);
      expect(en).not.toMatch(/[\u0600-\u06FF]/);
    }
    expect(approvalCodeMessage('request_stale', (a) => a)).toBe('الحساب تغيّر منذ تقديم الطلب. أُغلق الطلب. قدّم طلبًا جديدًا.');
    expect(approvalCodeMessage('target_inactive', (_a, e) => e)).toBe('You cannot promote a suspended or deleted account.');
    expect(approvalCodeMessage('other', (a) => a)).toBeNull();
  });
});
