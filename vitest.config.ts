import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/utils/**/*.test.ts',
      'src/verify/**/*.test.ts',
      'src/observability/**/*.test.ts',
      'src/pipeline/**/*.test.ts',
      'src/config/**/*.test.ts',
      'src/repos/**/*.test.ts',
      'src/discord/**/*.test.ts',
      'src/agents/**/*.test.ts',
      'src/audit/**/*.test.ts',
      'src/queue/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
      'dashboard/**/*.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
    env: {
      DISCORD_IFLEET_WEBHOOK: '',
      DISCORD_FALLBACK_CHANNEL_ID: '',
    },
  },
});
