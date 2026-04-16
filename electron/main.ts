import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  shell
} from 'electron';
import { createDesktopAppContext, type DesktopAppContext } from '@bridge/app-context';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import { registerIpcHandlers } from '@electron/ipc/register-handlers';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let appContext: DesktopAppContext | null = null;
let shutdownInProgress = false;
let shutdownPromise: Promise<void> | null = null;

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

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    show: true,
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
    appContext?.logger.error(
      { errorCode, errorDescription, validatedUrl },
      'Renderer failed to load'
    );
  });

  window.webContents.on('did-finish-load', () => {
    appContext?.logger.info(
      { url: window.webContents.getURL() },
      'Renderer finished loading'
    );
    window.show();
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
    await bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    if (appContext) {
      appContext.logger.error({ error }, 'Electron bootstrap failed');
    } else {
      console.error('Electron bootstrap failed (no app context):', error);
    }
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
