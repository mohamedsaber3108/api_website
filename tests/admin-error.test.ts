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

  it('audit_unavailable (503) is shown in the page language', () => {
    const ar = approvalCodeMessage('audit_unavailable', (a) => a) as string;
    const en = approvalCodeMessage('audit_unavailable', (_a, e) => e) as string;
    expect(ar).toBe('سجل التدقيق غير متاح، لذلك لم يُنفَّذ الإجراء. حاول لاحقًا.');
    expect(ar).not.toMatch(/[A-Za-z]/);
    expect(en).toBe('The audit log is unavailable, so this action was not done. Try again later.');
  });
});
