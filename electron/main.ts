import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell
} from 'electron';
import { createDesktopAppContext, type DesktopAppContext } from '@bridge/app-context';
import { APP_DISPLAY_NAME, APP_WINDOWS_APP_USER_MODEL_ID } from '@bridge/branding';
import { IpcChannels, type UpdateCheckResult } from '@bridge/ipc/contracts';
import { createLogger } from '@bridge/logging/logger';
import {
  DeferredPythonRuntimeProvisioner,
  type DeferredPythonSplashState
} from '@bridge/python/deferred-runtime';
import { fetchUpdateStatus } from '@bridge/update/service';
import { registerIpcHandlers } from '@electron/ipc/register-handlers';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const SPLASH_MIN_VISIBLE_MS = 5_000;
const SPLASH_STATUS_CHANNEL = 'helix:splash-status';
const UPDATE_CHECK_CHANNEL = 'helix:check-updates';
const GITHUB_REPO = 'Konohamaru04/Helix';
const UPDATE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const UPDATE_INITIAL_DELAY_MS = 5_000;

let lastUpdateStatus: UpdateCheckResult | null = null;
let updatePollHandle: NodeJS.Timeout | null = null;

async function runUpdateCheck(): Promise<UpdateCheckResult> {
  const result = await fetchUpdateStatus({
    currentVersion: app.getVersion(),
    repo: GITHUB_REPO
  });
  lastUpdateStatus = result;
  broadcastUpdateStatus(result);
  return result;
}

function broadcastUpdateStatus(result: UpdateCheckResult) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IpcChannels.updateStatusEvent, result);
    }
  }
}

function scheduleUpdatePolling() {
  if (updatePollHandle) {
    return;
  }
  setTimeout(() => {
    void runUpdateCheck().catch((error) => {
      appContext?.logger.warn({ error }, 'Initial update check failed');
    });
  }, UPDATE_INITIAL_DELAY_MS);
  updatePollHandle = setInterval(() => {
    void runUpdateCheck().catch((error) => {
      appContext?.logger.warn({ error }, 'Periodic update check failed');
    });
  }, UPDATE_POLL_INTERVAL_MS);
}

ipcMain.handle(UPDATE_CHECK_CHANNEL, () => runUpdateCheck());
ipcMain.handle(IpcChannels.updateCheckNow, () => runUpdateCheck());
ipcMain.handle(IpcChannels.updateGetLatest, () => lastUpdateStatus);
let appContext: DesktopAppContext | null = null;
let shutdownInProgress = false;
let shutdownPromise: Promise<void> | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashShownAt = 0;
let startupLogger: Logger | null = null;

function configureAppIdentity() {
  app.setName(APP_DISPLAY_NAME);

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_WINDOWS_APP_USER_MODEL_ID);
  }
}

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  'https:',
  'http:',
  'mailto:'
]);

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function applyContentSecurityPolicy() {
  const isDevServer = Boolean(process.env.ELECTRON_RENDERER_URL);
  if (isDevServer) {
    // Vite dev server needs eval and ws — keep CSP relaxed only in dev.
    return;
  }

  const policy = [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {};
    callback({
      responseHeaders: {
        ...responseHeaders,
        'Content-Security-Policy': [policy],
        'X-Content-Type-Options': ['nosniff']
      }
    });
  });
}

function getPreloadPath() {
  return path.join(currentDir, '../preload/preload.mjs');
}

function getRuntimeRootPath() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function configureAppPaths() {
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

function attachTextContextMenu(window: BrowserWindow) {
  window.webContents.on('context-menu', (_event, params) => {
    const selectedText = params.selectionText.trim();
    const template: MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (selectedText.length > 0) {
      template.push({ role: 'copy', enabled: params.editFlags.canCopy });
    }

    if (template.length === 0) {
      return;
    }

    Menu.buildFromTemplate(template).popup({ window });
  });
}

function getStartupLogger() {
  if (!startupLogger) {
    startupLogger = createLogger('startup', {
      logDirectory: path.join(app.getPath('userData'), 'logs')
    });
  }

  return startupLogger;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pushSplashStatus(state: DeferredPythonSplashState) {
  const window = splashWindow;

  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  window.webContents.send(SPLASH_STATUS_CHANNEL, state);
}

function closeSplashWindow() {
  const window = splashWindow;
  splashWindow = null;

  if (window && !window.isDestroyed()) {
    window.close();
  }
}

function focusBrowserWindow(window: BrowserWindow) {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  window.focus();
}

async function focusOrCreateMainWindow(reason: string) {
  if (shutdownInProgress) {
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    appContext?.logger.info({ reason }, 'Focusing existing main window');
    focusBrowserWindow(mainWindow);
    return;
  }

  const fallbackWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  if (fallbackWindow) {
    appContext?.logger.info({ reason }, 'Focusing existing Electron window');
    focusBrowserWindow(fallbackWindow);
    return;
  }

  if (!app.isReady() || !appContext) {
    appContext?.logger.info({ reason }, 'Window activation deferred until startup completes');
    return;
  }

  appContext.logger.info({ reason }, 'Creating main window for app activation');
  await createMainWindow();
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
      sandbox: false, // TODO: Enable sandbox — requires preload bundling refactor to remove direct Node.js APIs
      webSecurity: true,
      allowRunningInsecureContent: false
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
  const persistedBounds = appContext?.appStateRepository.getWindowBounds() ?? null;
  const initialOptions: Electron.BrowserWindowConstructorOptions = {
    width: persistedBounds?.width ?? 1560,
    height: persistedBounds?.height ?? 960,
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
      sandbox: false, // TODO: Enable sandbox — requires preload bundling refactor to remove direct Node.js APIs
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  };

  if (persistedBounds && persistedBounds.x !== null && persistedBounds.y !== null) {
    initialOptions.x = persistedBounds.x;
    initialOptions.y = persistedBounds.y;
  }

  const window = new BrowserWindow(initialOptions);

  mainWindow = window;
  attachTextContextMenu(window);

  if (persistedBounds?.isMaximized) {
    window.maximize();
  }

  let saveBoundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (window.isDestroyed()) {
      return;
    }
    const repository = appContext?.appStateRepository;
    if (!repository) {
      return;
    }
    const isMaximized = window.isMaximized();
    const normalBounds = isMaximized ? window.getNormalBounds() : window.getBounds();
    try {
      repository.setWindowBounds({
        width: normalBounds.width,
        height: normalBounds.height,
        x: normalBounds.x,
        y: normalBounds.y,
        isMaximized
      });
    } catch (error) {
      appContext?.logger.warn({ error }, 'Failed to persist window bounds');
    }
  };
  const scheduleBoundsSave = () => {
    if (saveBoundsTimer) {
      clearTimeout(saveBoundsTimer);
    }
    saveBoundsTimer = setTimeout(persistBounds, 500);
  };

  window.on('resize', scheduleBoundsSave);
  window.on('move', scheduleBoundsSave);
  window.on('maximize', persistBounds);
  window.on('unmaximize', persistBounds);
  window.on('close', () => {
    if (saveBoundsTimer) {
      clearTimeout(saveBoundsTimer);
      saveBoundsTimer = null;
    }
    persistBounds();
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      appContext?.logger.warn({ url }, 'Blocked window-open for disallowed URL scheme');
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) {
      return;
    }
    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      appContext?.logger.warn({ url }, 'Blocked navigation to disallowed URL scheme');
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
    rendererCrashCount = 0;
    void revealMainWindow(window);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    appContext?.logger.error({ details }, 'Renderer process exited unexpectedly');

    if (details.reason === 'crashed' || details.reason === 'killed' || details.reason === 'oom') {
      rendererCrashCount++;
      const RELOAD_DELAY_MS = 2_000;

      if (rendererCrashCount >= RENDERER_CRASH_THRESHOLD) {
        appContext?.logger.warn(
          { rendererCrashCount, threshold: RENDERER_CRASH_THRESHOLD },
          'Renderer crashed too many times — disabling hardware acceleration'
        );
        app.disableHardwareAcceleration();
      }

      appContext?.logger.info(
        { reason: details.reason, exitCode: details.exitCode, rendererCrashCount, reloadInMs: RELOAD_DELAY_MS },
        'Attempting renderer reload after crash'
      );
      setTimeout(() => {
        if (window.isDestroyed()) {
          return;
        }

        if (!window.webContents.isDestroyed()) {
          try {
            window.webContents.reload();
            appContext?.logger.info('Renderer reloaded after crash');
          } catch (reloadError) {
            appContext?.logger.error(
              { error: reloadError },
              'Failed to reload renderer after crash — closing and recreating window'
            );
            window.close();
            void createMainWindow();
          }
        } else {
          appContext?.logger.info('WebContents destroyed — closing and recreating window');
          window.close();
          void createMainWindow();
        }
      }, RELOAD_DELAY_MS);
    }
  });

  window.webContents.on('unresponsive', () => {
    appContext?.logger.warn('Renderer process became unresponsive');
    const UNRESPONSIVE_KILL_DELAY_MS = 15_000;
    setTimeout(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        appContext?.logger.warn(
          { killInMs: UNRESPONSIVE_KILL_DELAY_MS },
          'Renderer still unresponsive — will force close and recreate'
        );
        try {
          window.webContents.forcefullyCrashRenderer();
        } catch {
          // forcefullyCrashRenderer may throw if already gone
        }
      }
    }, UNRESPONSIVE_KILL_DELAY_MS);
  });

  window.webContents.on('responsive', () => {
    appContext?.logger.info('Renderer process became responsive again');
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(path.join(currentDir, '../renderer/index.html'));
  }

  return window;
}

async function bootstrap() {
  const logger = getStartupLogger();
  const reportSplash = (state: DeferredPythonSplashState) => {
    pushSplashStatus(state);
    logger.info({ ...state }, 'Splash startup status updated');
  };

  const pythonProvisioner = new DeferredPythonRuntimeProvisioner(
    getRuntimeRootPath(),
    app.getPath('userData'),
    logger.child({ scope: 'python-runtime' })
  );

  await pythonProvisioner.ensureReady(reportSplash);
  reportSplash({
    status: 'Starting local services',
    detail: 'Launching the bridge, database, Python server, and capability surface.',
    progress: null
  });

  appContext = await createDesktopAppContext({
    appPath: getRuntimeRootPath(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData')
  });
  registerIpcHandlers(appContext);
  reportSplash({
    status: 'Opening the app',
    detail: 'Preparing the main window after local services finished booting.',
    progress: 0.95
  });
  await createMainWindow();
  scheduleUpdatePolling();
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
  dialog.showErrorBox(
    'Helix encountered an error',
    `An unexpected error occurred: ${error instanceof Error ? error.message : String(error)}\n\nThe app will attempt to continue. Please restart if issues persist.`
  );
});

process.on('unhandledRejection', (reason) => {
  appContext?.logger.error({ reason }, 'Unhandled main-process rejection');
});

process.on('exit', () => {
  emergencyDisposeAppContext();
});

let gpuCrashCount = 0;
let rendererCrashCount = 0;
const GPU_CRASH_THRESHOLD = 3;
const RENDERER_CRASH_THRESHOLD = 3;

app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') {
    return;
  }

  gpuCrashCount++;
  appContext?.logger.error({ details, gpuCrashCount }, 'GPU process crashed');

  if (gpuCrashCount >= GPU_CRASH_THRESHOLD) {
    appContext?.logger.warn(
      { gpuCrashCount, threshold: GPU_CRASH_THRESHOLD },
      'GPU process crashed too many times — disabling hardware acceleration and restarting'
    );
    app.disableHardwareAcceleration();
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.reload();
        appContext?.logger.info('Reloaded renderer after GPU process crash');
      } catch {
        // ignore reload failures
      }
    }
  }
});

configureAppIdentity();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    appContext?.logger.info(
      { argv, workingDirectory },
      'Received second app instance request; focusing existing window'
    );
    void focusOrCreateMainWindow('second-instance');
  });

  void app
    .whenReady()
    .then(async () => {
      configureAppPaths();
      applyContentSecurityPolicy();
      await createSplashWindow().catch((error: unknown) => {
        console.warn('Unable to create splash window:', error);
      });
      await bootstrap();

      app.on('activate', () => {
        void focusOrCreateMainWindow('activate');
      });
    })
    .catch((error: unknown) => {
      closeSplashWindow();
      if (appContext) {
        appContext.logger.error({ error }, 'Electron bootstrap failed');
      } else if (startupLogger) {
        startupLogger.error({ error }, 'Electron bootstrap failed before app context startup');
      } else {
        console.error('Electron bootstrap failed (no app context):', error);
      }

      dialog.showErrorBox(
        'Startup Error',
        error instanceof Error ? error.message : 'Electron bootstrap failed.'
      );
      app.quit();
    });
}

app.on('before-quit', (event) => {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  event.preventDefault();

  if (updatePollHandle) {
    clearInterval(updatePollHandle);
    updatePollHandle = null;
  }

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
