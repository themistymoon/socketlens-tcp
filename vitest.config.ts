import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Needed only so the handful of `.tsx` component tests get the automatic JSX runtime.
  // The Node-environment tests are unaffected by it.
  plugins: [react()],
  resolve: {
    alias: [
      // Tests run straight against TypeScript sources so `npm test` never needs a prior build.
      {
        find: '@socketlens/protocol/browser',
        replacement: resolvePath('./packages/protocol/src/browser.ts'),
      },
      {
        find: '@socketlens/protocol',
        replacement: resolvePath('./packages/protocol/src/index.ts'),
      },
      // Ordered longest-prefix-first: aliases match by string prefix, so a bare
      // '@socketlens/core' entry placed above would rewrite '@socketlens/core/models'
      // into 'packages/core/src/index.ts/models'.
      {
        find: '@socketlens/core/models',
        replacement: resolvePath('./packages/core/src/models.ts'),
      },
      { find: '@socketlens/core', replacement: resolvePath('./packages/core/src/index.ts') },
      { find: '@socketlens/server', replacement: resolvePath('./apps/server/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', '{packages,apps}/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.tsbuild/**'],
    // Integration tests bind real TCP ports; a generous ceiling avoids flakes on slow machines.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        'apps/gui/src/main.tsx',
        'apps/gui/src/vite-env.d.ts',
        '**/*.test.{ts,tsx}',
      ],
    },
  },
});
