import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The Vite dev server only serves the React interface. All SLTP traffic is relayed
 * through the loopback bridge on port 7801, which owns the real TCP socket.
 */
export default defineConfig({
  root: resolvePath('.'),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@socketlens/protocol/browser',
        replacement: resolvePath('../../packages/protocol/src/browser.ts'),
      },
      {
        find: '@socketlens/protocol',
        replacement: resolvePath('../../packages/protocol/src/index.ts'),
      },
      {
        find: '@socketlens/core/models',
        replacement: resolvePath('../../packages/core/src/models.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/bridge': {
        target: 'http://127.0.0.1:7801',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: resolvePath('./dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
