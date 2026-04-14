import type { Config } from 'tailwindcss';

export default {
  content: ['./renderer/index.html', './renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        ember: '#f97316',
        sea: '#0f766e'
      },
      boxShadow: {
        panel: '0 20px 50px -30px rgba(15, 23, 42, 0.55)'
      }
    }
  },
  plugins: []
} satisfies Config;
