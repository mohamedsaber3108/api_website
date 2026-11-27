import { describe, expect, it } from 'vitest';
import { errorFields } from '../lib/auth-errors';

describe('errorFields', () => {
  it('maps known codes to fields', () => {
    expect(errorFields('invalid_credentials')).toEqual(['email', 'password']);
    expect(errorFields('email_taken')).toEqual(['email']);
  });
  it('returns no field for unknown, inherited or missing codes', () => {
    expect(errorFields('rate_limited')).toEqual([]);
    expect(errorFields('constructor')).toEqual([]);
    expect(errorFields(undefined)).toEqual([]);
  });
});
