import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  shell
} from 'electron';
import { createDesktopAppContext, type DesktopAppContext } from '@bridge/app-context';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import { registerIpcHandlers } from '@electron/ipc/register-handlers';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const SPLASH_MIN_VISIBLE_MS = 5_000;
let appContext: DesktopAppContext | null = null;
let shutdownInProgress = false;
let shutdownPromise: Promise<void> | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashShownAt = 0;

function getPreloadPath() {
  return path.join(currentDir, '../preload/preload.mjs');
}

function getRuntimeRootPath() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function configureAppPaths() {
  app.setName(APP_DISPLAY_NAME);

  const sessionDataPath = path.join(app.getPath('userData'), 'session');
  mkdirSync(sessionDataPath, { recursive: true });
  app.setPath('sessionData', sessionDataPath);
}

function getIconPath() {
  const runtimeRoot = getRuntimeRootPath();
  // ICO for Windows (best taskbar support), PNG fallback
  const icoPath = path.join(runtimeRoot, 'Assets/icon.ico');
  if (existsSync(icoPath)) return icoPath;
  return path.join(runtimeRoot, 'Assets/icon.png');
}

function getSplashScreenPath() {
  return path.join(getRuntimeRootPath(), 'Assets/splash/index.html');
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function closeSplashWindow() {
  const window = splashWindow;
  splashWindow = null;

  if (window && !window.isDestroyed()) {
    window.close();
  }
}

async function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    return splashWindow;
  }

  const window = new BrowserWindow({
    width: 760,
    height: 860,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    icon: getIconPath(),
    skipTaskbar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  splashWindow = window;

  window.on('closed', () => {
    if (splashWindow === window) {
      splashWindow = null;
    }
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    appContext?.logger.error(
      { errorCode, errorDescription, validatedUrl },
      'Splash renderer failed to load'
    );
  });

  await window.loadFile(getSplashScreenPath());

  if (!window.isDestroyed()) {
    splashShownAt = Date.now();
    window.show();
  }

  return window;
}

async function revealMainWindow(window: BrowserWindow) {
  const remaining =
    splashShownAt > 0
      ? Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt))
      : 0;

  if (remaining > 0) {
    await delay(remaining);
  }

  if (window.isDestroyed()) {
    return;
  }

  closeSplashWindow();
  appContext?.logger.info(
    { url: window.webContents.getURL(), splashVisibleMs: Math.max(Date.now() - splashShownAt, 0) },
    'Renderer finished loading'
  );
  window.show();
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: APP_DISPLAY_NAME,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    icon: getIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = window;

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    closeSplashWindow();
    appContext?.logger.error(
      { errorCode, errorDescription, validatedUrl },
      'Renderer failed to load'
    );
  });

  window.webContents.on('did-finish-load', () => {
    void revealMainWindow(window);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    appContext?.logger.error({ details }, 'Renderer process exited unexpectedly');
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(path.join(currentDir, '../renderer/index.html'));
  }

  return window;
}

async function bootstrap() {
  appContext = await createDesktopAppContext({
    appPath: getRuntimeRootPath(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData')
  });
  registerIpcHandlers(appContext);
  await createMainWindow();
  appContext.logger.info({ userDataPath: app.getPath('userData') }, 'Electron app ready');
}

async function disposeAppContext() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  const context = appContext;

  if (!context) {
    return;
  }

  shutdownPromise = (async () => {
    try {
      await context.dispose();
    } finally {
      if (appContext === context) {
        appContext = null;
      }
    }
  })();

  return shutdownPromise.finally(() => {
    shutdownPromise = null;
  });
}

function emergencyDisposeAppContext() {
  if (!appContext) {
    return;
  }

  try {
    appContext.disposeSync();
  } finally {
    appContext = null;
  }
}

process.on('uncaughtException', (error) => {
  appContext?.logger.error({ error }, 'Uncaught main-process exception');
  emergencyDisposeAppContext();
});

process.on('unhandledRejection', (reason) => {
  appContext?.logger.error({ reason }, 'Unhandled main-process rejection');
});

process.on('exit', () => {
  emergencyDisposeAppContext();
});

void app
  .whenReady()
  .then(async () => {
    configureAppPaths();
    await createSplashWindow().catch((error: unknown) => {
      console.warn('Unable to create splash window:', error);
    });
    await bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    closeSplashWindow();
    if (appContext) {
      appContext.logger.error({ error }, 'Electron bootstrap failed');
    } else {
      console.error('Electron bootstrap failed (no app context):', error);
    }

    dialog.showErrorBox(
      'Startup Error',
      error instanceof Error ? error.message : 'Electron bootstrap failed.'
    );
    app.quit();
  });

app.on('before-quit', (event) => {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  event.preventDefault();

  void Promise.race([
    disposeAppContext(),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        appContext?.logger.warn(
          'App shutdown cleanup timed out; continuing with forced exit path'
        );
        resolve();
      }, 8000);
    })
  ]).finally(() => {
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
