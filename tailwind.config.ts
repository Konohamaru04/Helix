import type { Config } from 'tailwindcss';

export default {
  content: ['./renderer/index.html', './renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        'sm': '768px',
        'md': '1024px'
      },
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        ember: '#f97316',
        sea: '#0f766e'
      },
      boxShadow: {
        panel: '0 20px 50px -30px rgba(15, 23, 42, 0.55)'
      },
      transitionDuration: {
        'instant': '75ms',
        'expressive': '600ms'
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'spring-gentle': 'cubic-bezier(0.22, 1.2, 0.36, 1)'
      },
      animation: {
        'fade-in-up': 'fade-in-up 250ms cubic-bezier(0, 0, 0.2, 1)',
        'fade-in': 'fade-in 300ms cubic-bezier(0, 0, 0.2, 1)',
        'slide-in-left': 'slide-in-left 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
        'slide-in-right': 'slide-in-right 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
        'slide-in-up': 'slide-in-up 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
        'scale-in': 'scale-in 200ms cubic-bezier(0, 0, 0.2, 1)',
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'border-flash-rose': 'border-flash-rose 400ms ease-out'
      }
    }
  },
  plugins: []
} satisfies Config;
