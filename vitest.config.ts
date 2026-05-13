import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/verify/**/*.test.ts', 'src/observability/**/*.test.ts', 'src/pipeline/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
  },
});
