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
  shell
} from 'electron';
import { createDesktopAppContext, type DesktopAppContext } from '@bridge/app-context';
import { APP_DISPLAY_NAME, APP_WINDOWS_APP_USER_MODEL_ID } from '@bridge/branding';
import { createLogger } from '@bridge/logging/logger';
import {
  DeferredPythonRuntimeProvisioner,
  type DeferredPythonSplashState
} from '@bridge/python/deferred-runtime';
import { registerIpcHandlers } from '@electron/ipc/register-handlers';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const SPLASH_MIN_VISIBLE_MS = 5_000;
const SPLASH_STATUS_CHANNEL = 'helix:splash-status';
const UPDATE_CHECK_CHANNEL = 'helix:check-updates';
const UPDATE_CHECK_TIMEOUT_MS = 6_000;
const GITHUB_REPO = 'Konohamaru04/Helix';

type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  latestCommit: { sha: string; message: string; date: string; url: string } | null;
  error: string | null;
};

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const li = left[i] ?? 0;
    const ri = right[i] ?? 0;
    if (li !== ri) return li < ri ? -1 : 1;
  }
  return 0;
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpdateStatus(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Helix/${currentVersion}`
  };
  try {
    const [releasePayload, commitsPayload] = await Promise.allSettled([
      fetchJsonWithTimeout(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, headers),
      fetchJsonWithTimeout(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=1`, headers)
    ]);

    let latestVersion: string | null = null;
    let releaseUrl: string | null = null;
    let publishedAt: string | null = null;
    if (releasePayload.status === 'fulfilled') {
      const release = releasePayload.value as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
      };
      latestVersion = release.tag_name ?? null;
      releaseUrl = release.html_url ?? null;
      publishedAt = release.published_at ?? null;
    }

    let latestCommit: UpdateCheckResult['latestCommit'] = null;
    if (commitsPayload.status === 'fulfilled' && Array.isArray(commitsPayload.value)) {
      const first = (commitsPayload.value as Array<{
        sha: string;
        html_url?: string;
        commit: { message: string; author: { date: string } };
      }>)[0];
      if (first) {
        latestCommit = {
          sha: first.sha.slice(0, 7),
          message: ((first.commit.message ?? '').split('\n')[0] ?? '').slice(0, 140),
          date: first.commit.author.date,
          url: first.html_url ?? `https://github.com/${GITHUB_REPO}/commit/${first.sha}`
        };
      }
    }

    const hasUpdate = latestVersion !== null && compareSemver(currentVersion, latestVersion) < 0;
    const error =
      releasePayload.status === 'rejected' && commitsPayload.status === 'rejected'
        ? releasePayload.reason instanceof Error
          ? releasePayload.reason.message
          : String(releasePayload.reason)
        : null;

    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      publishedAt,
      latestCommit,
      error
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: null,
      publishedAt: null,
      latestCommit: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

ipcMain.handle(UPDATE_CHECK_CHANNEL, () => fetchUpdateStatus());
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
  attachTextContextMenu(window);

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
    rendererCrashCount = 0;
    void revealMainWindow(window);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    appContext?.logger.error({ details }, 'Renderer process exited unexpectedly');

    if (details.reason === 'crashed' || details.reason === 'killed') {
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
