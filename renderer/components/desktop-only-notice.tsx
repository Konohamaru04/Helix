import { APP_DISPLAY_NAME } from '@bridge/branding';

export function DesktopOnlyNotice() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(45,212,191,0.18),_transparent_40%),radial-gradient(circle_at_bottom_right,_rgba(249,115,22,0.16),_transparent_30%)]" />
      <main className="relative flex min-h-screen items-center justify-center px-6 py-12">
        <section className="w-full max-w-3xl rounded-[2rem] border border-white/10 bg-slate-900/80 p-8 shadow-panel backdrop-blur">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
            Desktop Runtime Required
          </p>
          <h1 className="mt-4 text-4xl font-semibold text-white">
            This page is the Electron renderer, not a standalone web app.
          </h1>
          <p className="mt-5 text-base leading-8 text-slate-300">
            The Vite dev server can be opened in a browser, but the actual product UI
            expects Electron&apos;s preload bridge. Open the Electron window launched by
            `npm run dev` instead of browsing to the localhost URL directly.
          </p>
          <div className="mt-8 rounded-2xl border border-white/10 bg-slate-950/80 p-5 text-sm text-slate-300">
            <p className="font-medium text-white">Expected workflow</p>
            <p className="mt-3">
              Run <code>npm run dev</code>, then use the native Electron window named
              <code>{` ${APP_DISPLAY_NAME}`}</code>. The browser tab is only the renderer dev
              server and does not have access to the desktop bridge.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
