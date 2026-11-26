/** One-language text for the approval error codes that have fixed wording. Returns null for any other code. */
export function approvalCodeMessage(code: string | undefined, tr: (ar: string, en: string) => string): string | null {
  switch (code) {
    case 'super_admin_required': return tr('هذا الإجراء للمدير الأعلى فقط.', 'Only a super admin can do this.');
    case 'self_approval': return tr('لا يمكنك الموافقة على طلبك. يجب أن يوافق مدير آخر.', 'You cannot approve your own request. Another admin must approve it.');
    case 'self_target': return tr('لا يمكنك الموافقة على طلب يخص حسابك.', 'You cannot approve a request about your own account.');
    case 'request_expired': return tr('انتهت صلاحية الطلب (٢٤ ساعة). قدّم طلبًا جديدًا.', 'This request expired (24 hours). Make a new one.');
    case 'request_closed': return tr('تم البتّ في هذا الطلب من قبل.', 'This request was already decided.');
    case 'request_stale': return tr('الحساب تغيّر منذ تقديم الطلب. أُغلق الطلب. قدّم طلبًا جديدًا.', 'The account changed after this request was made. The request is closed. Make a new one.');
    case 'target_inactive': return tr('لا يمكن ترقية حساب موقوف أو محذوف.', 'You cannot promote a suspended or deleted account.');
    default: return null;
  }
}
