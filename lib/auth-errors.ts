export type AuthField = 'name' | 'email' | 'password';

/** Which form fields an API error code belongs to. Unknown codes name no field. */
export function errorFields(code?: string): AuthField[] {
  switch (code) {
    case 'invalid_credentials': return ['email', 'password'];
    case 'email_taken': return ['email'];
    default: return [];
  }
}
