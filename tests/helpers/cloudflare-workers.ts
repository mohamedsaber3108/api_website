// Test stand-in for the `cloudflare:workers` module. Tests mutate `env` (DB, secrets, flags).
export const env: Record<string, unknown> & { DB?: D1Database } = {};
