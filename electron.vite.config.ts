import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@bridge': path.resolve(rootDir, 'bridge'),
        '@electron': path.resolve(rootDir, 'electron')
      }
    },
    build: {
      target: 'node22',
      outDir: 'dist/main',
      rollupOptions: {
        input: path.resolve(rootDir, 'electron/main.ts'),
        output: {
          preserveModules: true,
          entryFileNames: 'index.js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@bridge': path.resolve(rootDir, 'bridge')
      }
    },
    build: {
      target: 'node22',
      outDir: 'dist/preload',
      rollupOptions: {
        input: path.resolve(rootDir, 'electron/preload.ts'),
        output: {
          entryFileNames: 'index.js'
        }
      }
    }
  },
  renderer: {
    root: path.resolve(rootDir, 'renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@bridge': path.resolve(rootDir, 'bridge'),
        '@renderer': path.resolve(rootDir, 'renderer')
      }
    },
    build: {
      outDir: path.resolve(rootDir, 'dist/renderer'),
      rollupOptions: {
        input: path.resolve(rootDir, 'renderer/index.html')
      }
    }
  }
});
