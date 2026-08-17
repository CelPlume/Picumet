import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
