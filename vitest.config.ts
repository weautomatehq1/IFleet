import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/utils/**/*.test.ts',
      'src/verify/**/*.test.ts',
      'src/observability/**/*.test.ts',
      'src/pipeline/**/*.test.ts',
      'src/config/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
  },
});
