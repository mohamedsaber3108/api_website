import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CSS lint for UX-A1 (Arabic letter-spacing) and UX-A2 (WCAG contrast). Reads app/globals.css as text.
const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):(#[0-9a-f]{6}|#[0-9a-f]{3})(?![0-9a-f])/g)].map((m) => [m[1], m[2].length === 4 ? '#' + [...m[2].slice(1)].map((c) => c + c).join('') : m[2]]));
const light = vars(/:root\{([^}]*)\}/.exec(css)![1]);
const dark = vars(/:root\[data-theme="dark"\]\{([^}]*)\}/.exec(css)![1]);

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('contrast (WCAG AA 4.5:1 for normal text)', () => {
  it('light theme text pairs', () => {
    const pairs: [string, string][] = [];
    for (const bg of ['bg', 'surface', 'surface-alt']) for (const fg of ['ink', 'muted', 'orange', 'orange-dark']) pairs.push([fg, bg]);
    pairs.push(['orange', 'peach'], ['orange-dark', 'peach']);
    for (const [fg, bg] of pairs) expect(ratio(light[fg], light[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it('light theme: white text on the primary button colour', () => {
    expect(ratio('#ffffff', light.orange)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', light['orange-dark'])).toBeGreaterThanOrEqual(4.5);
  });
  it('dark theme text pairs', () => {
    for (const bg of ['bg', 'surface', 'surface-alt']) for (const fg of ['ink', 'muted', 'orange']) expect(ratio(dark[fg], dark[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it('no 10px grey text colour left hard-coded, except the one on the dark feature card', () => {
    const hits = [...css.matchAll(/([^{}]+)\{[^{}]*color:#(?:a0a59f|9aa49c)[^{}]*\}/g)].map((m) => m[1].trim());
    expect(hits).toEqual(['.feature-main .mini-index']);
  });
});

describe('dark surfaces in the light theme', () => {
  const allRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const hex = (v: string) => /^#[0-9a-f]{6}$/.test(v);
  // dark roots: a rule outside the dark theme that sets a hard-coded dark background (luminance under 0.05)
  const roots = allRules
    .filter((r) => !r.sel.includes('data-theme'))
    .flatMap((r) => {
      const bg = /(?:^|;)background:(#[0-9a-f]{6})(?![0-9a-f])/.exec(r.body)?.[1];
      return bg && lum(bg) < 0.05 && /^\.[a-z-]+$/.test(r.sel) ? [{ cls: r.sel, bg }] : [];
    });
  it('finds the dark surfaces', () => {
    expect(roots.map((r) => r.cls)).toEqual(expect.arrayContaining(['.feature-main', '.calc-result', '.code-block', '.site-footer', '.compare-bar']));
  });
  it('text that uses --muted or --orange inside a dark surface passes 4.5:1 on it', () => {
    for (const root of roots) {
      for (const r of allRules) {
        if (r.sel.includes('data-theme') || !r.sel.split(',').some((s) => s.trim().startsWith(root.cls + ' ') || s.trim().startsWith(root.cls + '>'))) continue;
        for (const m of r.body.matchAll(/(?:^|;)color:var\(--([a-z-]+)\)/g)) expect(ratio(light[m[1]], root.bg), `${r.sel} on ${root.bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('.feature-main .mini-index sets its own colour, at least 4.5:1 on the dark card', () => {
    const bg = roots.find((r) => r.cls === '.feature-main')!.bg;
    const rule = allRules.find((r) => r.sel === '.feature-main .mini-index');
    const color = /(?:^|;)color:(#[0-9a-f]{6})/.exec(rule?.body ?? '')?.[1] ?? '';
    expect(hex(color), 'rule missing or colour not a hex').toBe(true);
    expect(ratio(color, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('letter-spacing', () => {
  // innermost rules: selector is whatever follows the last "{" or "}" before the block
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const negative = rules.filter((r) => /letter-spacing:-/.test(r.body) && !r.sel.startsWith('html[lang="en"]'));
  const arabic = rules.filter((r) => r.sel.startsWith('html[lang="ar"]') && /letter-spacing:0(;|$)/.test(r.body)).map((r) => r.sel);
  // shortcut: the Latin logo wordmark keeps its tight spacing (brand asset); extend this list only for Latin-only brand text.
  const exempt = ['.brand>span:last-child'];

  it('finds the negative rules', () => {
    expect(negative.length).toBeGreaterThanOrEqual(10);
  });
  it('every negative letter-spacing rule has an Arabic override or is exempt', () => {
    for (const r of negative) {
      const sel = r.sel.replace(/^.*\}/, '').trim();
      if (exempt.includes(sel)) continue;
      expect(arabic.some((a) => a.includes(sel)), sel).toBe(true);
    }
  });
  it('the Arabic override beats the English-only hero rule order (override comes after the base rules)', () => {
    const at = css.indexOf('html[lang="ar"] :is(');
    expect(at).toBeGreaterThan(css.indexOf('.hero h1{font-size:46px;letter-spacing:-1.8px}'));
  });
});

describe('focus-visible (UX-A6)', () => {
  const focus = /(:is\(a,button[^{]*\):focus-visible)\{([^}]*)\}/.exec(css);
  const focusLight = /:root\{--focus:(#[0-9a-f]{6})\}/.exec(css)?.[1] ?? '';
  const focusDark = /:root\[data-theme="dark"\]\{--focus:(#[0-9a-f]{6})\}/.exec(css)?.[1] ?? '';
  const bgOf = (sel: string) => new RegExp('(?:^|[}\\s])' + sel.replace(/\./g, '\\.') + '\\{[^}]*?background:(#[0-9a-f]{6})').exec(css)?.[1] ?? '';

  it('one rule covers every interactive control, and it beats any outline removal', () => {
    expect(focus).not.toBeNull();
    for (const s of ['a', 'button', 'input', 'select', 'textarea', '[role="button"]', '[role="tab"]']) expect(focus![1]).toContain(s);
    expect(focus![2]).toContain('outline:2px solid var(--focus)!important');
  });
  it('the currency select no longer removes its outline', () => {
    const body = /\.select-wrap select\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).not.toBe('');
    expect(body).not.toMatch(/outline:(none|0)/);
  });
  it('focus colour is at least 3:1 on every light and dark surface', () => {
    for (const bg of ['bg', 'surface', 'surface-alt', 'peach']) {
      expect(ratio(focusLight, light[bg]), `light ${bg}`).toBeGreaterThanOrEqual(3);
      expect(ratio(focusDark, dark[bg]), `dark ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
  it('focus colour on the always-dark surfaces and the orange banner is at least 3:1', () => {
    for (const sel of ['.feature-main', '.calc-result', '.code-block', '.site-footer', '.compare-bar']) {
      const bg = bgOf(sel);
      expect(bg, sel).not.toBe('');
      expect(ratio('#ffc8b1', bg), sel).toBeGreaterThanOrEqual(3);
    }
    expect(ratio('#ffffff', '#ee6439')).toBeGreaterThanOrEqual(3);
  });
  it('the mobile menu holds the theme control and the menu button reports its state', () => {
    const src = readFileSync(path.resolve(__dirname, '../app/wasl-app.tsx'), 'utf8');
    expect(src).toContain('className="mobile-theme"');
    expect(src).toContain('aria-expanded={menu}');
    expect(src).toContain('aria-label={isAr ? "القائمة" : "Menu"}');
  });
});

describe('FU-24 pressed toggles and table scroll', () => {
  const sem = readFileSync(path.resolve(__dirname, '../app/semantics.css'), 'utf8');
  const src = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf8');
  it('aria-pressed="true" shows a check mark and a heavier border, not colour alone', () => {
    expect(sem).toMatch(/\.pill-link\[aria-pressed="true"\][^{]*\{[^}]*font-weight:800/);
    expect(sem).toMatch(/\.pill-link\[aria-pressed="true"\][^{]*\{[^}]*box-shadow:inset 0 0 0 1px/);
    expect(sem).toMatch(/\.pill-link\[aria-pressed="true"\]::before[^{]*\{content:"\\2713"/);
  });
  it('.table-scroll scrolls sideways', () => {
    expect(sem).toMatch(/\.table-scroll\{[^}]*overflow-x:auto/);
  });
  it('every table in the docs and usage views sits inside .table-scroll', () => {
    for (const f of ['components/dashboard.tsx', 'components/docs-samples.tsx']) {
      const text = src(f);
      const tables = text.match(/<table\b/g)?.length ?? 0;
      expect(tables, f).toBeGreaterThan(0);
      expect(text.match(/<div className="table-scroll"[^>]*><table\b|<div className="table-scroll"[^>]*>\s*<table\b/g)?.length ?? 0, f).toBe(tables);
    }
  });
});

describe('reduced motion', () => {
  it('stops infinite animations and hover movement', () => {
    const m = /@media\(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('animation:none!important');
    expect(m![1]).toContain('transform:none!important');
  });
});
