import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    target: 'node22',
    outDir: path.resolve(rootDir, 'dist/tui'),
    lib: {
      entry: path.resolve(rootDir, 'tui/main.ts'),
      formats: ['esm'],
      fileName: () => 'main.js'
    },
    rollupOptions: {
      external: [
        'blessed',
        'markdown-it',
        'better-sqlite3',
        'pino',
        'zod',
        'node:child_process',
        'node:fs',
        'node:path',
        'node:url',
        'node:os',
        'node:crypto',
        'node:stream',
        'node:util',
        'node:events',
        'node:http',
        'node:https',
        'node:net'
      ],
      output: {
        preserveModules: true,
        entryFileNames: '[name].js'
      }
    }
  },
  resolve: {
    alias: {
      '@bridge': path.resolve(rootDir, 'bridge'),
      '@tui': path.resolve(rootDir, 'tui')
    }
  }
});