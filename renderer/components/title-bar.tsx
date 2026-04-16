import { useState, useEffect } from 'react';
import { APP_DISPLAY_NAME } from '@bridge/branding';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      const maximized = await window.ollamaDesktop.window.isMaximized();
      setIsMaximized(maximized);
    };

    checkMaximized();

    const handleResize = () => {
      checkMaximized();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleMinimize = () => {
    void window.ollamaDesktop.window.minimize();
  };

  const handleMaximize = async () => {
    await window.ollamaDesktop.window.maximize();
    const maximized = await window.ollamaDesktop.window.isMaximized();
    setIsMaximized(maximized);
  };

  const handleClose = () => {
    void window.ollamaDesktop.window.close();
  };

  return (
    <div
      className="h-10 bg-slate-950 border-b border-slate-800 flex items-center justify-between select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 px-4">
        <span className="text-slate-100 font-medium text-sm">{APP_DISPLAY_NAME}</span>
      </div>

      <div
        className="flex items-center h-full"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={handleMinimize}
          className="w-12 h-full flex items-center justify-center text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          aria-label="Minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="0" y="5" width="12" height="2" fill="currentColor" />
          </svg>
        </button>

        <button
          onClick={handleMaximize}
          className="w-12 h-full flex items-center justify-center text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2 4v6h6V4H2zm5 5H3V5h4v4z"
                fill="currentColor"
              />
              <path
                d="M4 2v2h1V3h4v4h-1v1h2V2H4z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect
                x="1"
                y="1"
                width="10"
                height="10"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
              />
            </svg>
          )}
        </button>

        <button
          onClick={handleClose}
          className="w-12 h-full flex items-center justify-center text-slate-400 hover:bg-red-600 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M1 1L6 6M11 11L6 6M6 6L11 1M6 6L1 11"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
