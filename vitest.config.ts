import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: tests run in plain Node with a local D1, not in the vinext build.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': path.resolve(__dirname, 'tests/helpers/cloudflare-workers.ts') } },
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
});
