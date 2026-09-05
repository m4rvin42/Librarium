import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    sequence: { concurrent: false },
    fileParallelism: false,
    pool: 'threads',
    maxWorkers: 1,
  },
});
