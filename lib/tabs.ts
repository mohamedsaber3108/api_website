import type React from 'react';

/**
 * Arrow-key move for role="tablist" (UX-A5). Returns the index to focus, or null when the key is not a tab key.
 * Left and Right follow the reading direction (flipped in RTL). Up and Down work when the list is vertical.
 */
export function nextTabIndex(key: string, index: number, count: number, opts: { rtl: boolean; vertical?: boolean }): number | null {
  if (count < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  let step = 0;
  if (key === 'ArrowRight') step = opts.rtl ? -1 : 1;
  else if (key === 'ArrowLeft') step = opts.rtl ? 1 : -1;
  else if (opts.vertical && key === 'ArrowDown') step = 1;
  else if (opts.vertical && key === 'ArrowUp') step = -1;
  if (step === 0) return null;
  return (index + step + count) % count;
}

/** onKeyDown for the tablist element. Moves focus and activates the tab (automatic activation). */
export function onTabListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const list = e.currentTarget;
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const next = nextTabIndex(e.key, at, tabs.length, { rtl: getComputedStyle(list).direction === 'rtl', vertical: list.getAttribute('aria-orientation') === 'vertical' });
  if (next === null) return;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
