import { describe, expect, it } from 'vitest';
import { loginUrl, SESSION_REASONS, sessionReasonFrom } from '../lib/session-reason';

describe('sign-in reason from the URL', () => {
  it('accepts a listed reason only', () => {
    expect(sessionReasonFrom('?reason=session_ended')).toBe('session_ended');
    expect(sessionReasonFrom('')).toBeNull();
    expect(sessionReasonFrom('?reason=<script>alert(1)</script>')).toBeNull();
    expect(sessionReasonFrom('?reason=constructor')).toBeNull();
    expect(sessionReasonFrom('?reason=__proto__')).toBeNull();
    expect(sessionReasonFrom('?reason=SESSION_ENDED')).toBeNull();
  });
  it('has Arabic and English text for every reason, and the login URL round-trips', () => {
    for (const r of Object.values(SESSION_REASONS)) {
      expect(r.ar.length).toBeGreaterThan(0);
      expect(r.en.length).toBeGreaterThan(0);
    }
    expect(loginUrl()).toBe('/login');
    expect(sessionReasonFrom(loginUrl('session_ended').split('?')[1] ? `?${loginUrl('session_ended').split('?')[1]}` : '')).toBe('session_ended');
  });
});
