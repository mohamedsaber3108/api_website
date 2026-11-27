import { describe, expect, it } from 'vitest';
import { renderMail } from '../lib/server/mail-templates';

describe('mail name with replace patterns (PR 23 review)', () => {
  it('keeps a name with dollar patterns as typed', () => {
    const name = 'A$&B$C';
    const m = renderMail('verify_email', 'en', { link: 'https://wasl.example/x', name });
    expect(m.html).toContain('<bdi>A$&amp;B$C</bdi>');
  });
});
