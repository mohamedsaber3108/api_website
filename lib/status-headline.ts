export type HeadlineLang = 'ar' | 'en';

/** Status page headline when the checks are fine. Handles 0, 1 and many open incidents, with Arabic plural forms. */
export function openIncidentsHeadline(count: number, lang: HeadlineLang): string {
  if (lang === 'en') {
    if (count <= 0) return 'All systems operational';
    return count === 1 ? 'Systems working, one incident is open' : `Systems working, ${count} incidents are open`;
  }
  if (count <= 0) return 'كل الأنظمة تعمل';
  const rest = 'كل الأنظمة تعمل، و';
  if (count === 1) return `${rest}يوجد حادث مفتوح`;
  if (count === 2) return `${rest}يوجد حادثان مفتوحان`;
  if (count <= 10) return `${rest}يوجد ${count} حوادث مفتوحة`;
  return `${rest}يوجد ${count} حادثًا مفتوحًا`;
}
