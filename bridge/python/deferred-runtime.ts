import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';

const DEFERRED_RUNTIME_MANIFEST_VERSION = 1;
const MAX_PROGRESS_LINES = 12;
const MAX_SPLASH_DETAIL_LENGTH = 110;

export const DEFERRED_PYTHON_SENTINELS = [
  'numpy',
  'numpy.libs',
  'einops',
  'transformers',
  'tokenizers',
  'sentencepiece',
  'safetensors',
  'aiohttp',
  'yarl',
  'yaml',
  '_yaml',
  'PIL',
  'scipy',
  'tqdm',
  'psutil',
  'alembic',
  'sqlalchemy',
  'filelock',
  'av',
  'requests',
  'simpleeval.py',
  'blake3'
] as const;

interface DeferredPythonRuntimeManifest {
  manifestVersion: number;
  requirementsHash: string;
  requirements: string[];
  provisionedAt: string;
}

export interface DeferredPythonSplashState {
  status: string;
  detail: string;
  progress: number | null;
}

export function getDeferredPythonRequirementsPath(appPath: string) {
  return path.join(appPath, 'config', 'python-deferred-requirements.txt');
}

export function getDeferredPythonRuntimeRoot(userDataPath: string) {
  return path.join(userDataPath, 'python-runtime');
}

export function getDeferredPythonSitePackagesPath(userDataPath: string) {
  return path.join(getDeferredPythonRuntimeRoot(userDataPath), 'site-packages');
}

export function getDeferredPythonManifestPath(userDataPath: string) {
  return path.join(getDeferredPythonRuntimeRoot(userDataPath), 'manifest.json');
}

export function parseDeferredPythonRequirements(contents: string) {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function getDeferredPythonRequirementsHash(contents: string) {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

export function isDeferredPythonRuntimeReady(userDataPath: string, requirementsHash: string) {
  const manifestPath = getDeferredPythonManifestPath(userDataPath);
  const sitePackagesPath = getDeferredPythonSitePackagesPath(userDataPath);

  if (!existsSync(manifestPath) || !existsSync(sitePackagesPath)) {
    return false;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8')
    ) as DeferredPythonRuntimeManifest;

    if (
      manifest.manifestVersion !== DEFERRED_RUNTIME_MANIFEST_VERSION ||
      manifest.requirementsHash !== requirementsHash
    ) {
      return false;
    }

    return DEFERRED_PYTHON_SENTINELS.every((entry) =>
      existsSync(path.join(sitePackagesPath, entry))
    );
  } catch {
    return false;
  }
}

function getEmbeddedPythonPath(appPath: string) {
  return path.join(appPath, 'python_embeded', 'python.exe');
}

function summarizePackageList(prefix: string, packageList: string) {
  const packages = packageList
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (packages.length === 0) {
    return prefix;
  }

  const preview = packages.slice(0, 4).join(', ');
  return `${prefix} (${packages.length}): ${preview}${packages.length > 4 ? ', ...' : ''}`;
}

function summarizeSpaceSeparatedPackages(prefix: string, packageList: string) {
  const packages = packageList
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (packages.length === 0) {
    return prefix;
  }

  const preview = packages.slice(0, 4).join(', ');
  return `${prefix} (${packages.length}): ${preview}${packages.length > 4 ? ', ...' : ''}`;
}

export function formatDeferredPythonInstallerLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('Requirement already satisfied:')) {
    return trimmed.replace(/^Requirement already satisfied:\s*/u, 'Using ');
  }

  const installingMatch = trimmed.match(/^Installing collected packages:\s*(.+)$/u);

  if (installingMatch) {
    return summarizePackageList('Installing packages', installingMatch[1] ?? '');
  }

  const installedMatch = trimmed.match(/^Successfully installed\s+(.+)$/u);

  if (installedMatch) {
    return summarizeSpaceSeparatedPackages('Installed packages', installedMatch[1] ?? '');
  }

  if (trimmed.length <= MAX_SPLASH_DETAIL_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_SPLASH_DETAIL_LENGTH - 3).trimEnd()}...`;
}

function formatInstallerLine(line: string) {
  return formatDeferredPythonInstallerLine(line);
}

export class DeferredPythonRuntimeProvisioner {
  constructor(
    private readonly appPath: string,
    private readonly userDataPath: string,
    private readonly logger: Logger
  ) {}

  async ensureReady(
    onProgress?: (state: DeferredPythonSplashState) => void
  ): Promise<string> {
    const requirementsPath = getDeferredPythonRequirementsPath(this.appPath);
    const requirementsContents = await readFile(requirementsPath, 'utf8');
    const requirements = parseDeferredPythonRequirements(requirementsContents);
    const requirementsHash = getDeferredPythonRequirementsHash(requirementsContents);
    const sitePackagesPath = getDeferredPythonSitePackagesPath(this.userDataPath);

    onProgress?.({
      status: 'Checking Python packages',
      detail: 'Verifying the deferred runtime required for local generation.',
      progress: null
    });

    if (isDeferredPythonRuntimeReady(this.userDataPath, requirementsHash)) {
      this.logger.info(
        { sitePackagesPath, requirementCount: requirements.length },
        'Deferred Python runtime already provisioned'
      );

      onProgress?.({
        status: 'Python packages ready',
        detail: 'Using the existing deferred runtime from the local app data directory.',
        progress: 1
      });

      return sitePackagesPath;
    }

    const embeddedPython = getEmbeddedPythonPath(this.appPath);

    if (!existsSync(embeddedPython)) {
      throw new Error(
        'Expected bundled runtime at python_embeded\\python.exe, but it was not found.'
      );
    }

    const runtimeRoot = getDeferredPythonRuntimeRoot(this.userDataPath);
    const pipCachePath = path.join(runtimeRoot, 'pip-cache');
    const stagingPath = path.join(runtimeRoot, `site-packages.install-${Date.now()}`);
    const backupPath = path.join(runtimeRoot, 'site-packages.previous');
    const manifestPath = getDeferredPythonManifestPath(this.userDataPath);

    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(pipCachePath, { recursive: true });
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true });

    this.logger.info(
      { sitePackagesPath, requirementCount: requirements.length },
      'Provisioning deferred Python runtime'
    );

    onProgress?.({
      status: 'Installing Python packages',
      detail: 'Downloading and installing first-run runtime dependencies.',
      progress: null
    });

    try {
      await this.installPackages(embeddedPython, requirementsPath, stagingPath, pipCachePath, onProgress);

      await rm(backupPath, { recursive: true, force: true });

      if (existsSync(sitePackagesPath)) {
        await rename(sitePackagesPath, backupPath);
      }

      await rename(stagingPath, sitePackagesPath);

      const manifest: DeferredPythonRuntimeManifest = {
        manifestVersion: DEFERRED_RUNTIME_MANIFEST_VERSION,
        requirementsHash,
        requirements,
        provisionedAt: new Date().toISOString()
      };

      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await rm(backupPath, { recursive: true, force: true });

      this.logger.info(
        { sitePackagesPath, requirementCount: requirements.length },
        'Deferred Python runtime provisioned successfully'
      );

      onProgress?.({
        status: 'Python packages ready',
        detail: 'Deferred runtime installed successfully. Starting local services next.',
        progress: 1
      });

      return sitePackagesPath;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });

      if (!existsSync(sitePackagesPath) && existsSync(backupPath)) {
        await rename(backupPath, sitePackagesPath).catch(() => {});
      }

      await rm(backupPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private installPackages(
    embeddedPython: string,
    requirementsPath: string,
    targetPath: string,
    pipCachePath: string,
    onProgress?: (state: DeferredPythonSplashState) => void
  ) {
    return new Promise<void>((resolve, reject) => {
      const recentLines: string[] = [];
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const installProcess = spawn(
        embeddedPython,
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-input',
          '--progress-bar',
          'off',
          '--upgrade',
          '--ignore-installed',
          '--target',
          targetPath,
          '-r',
          requirementsPath
        ],
        {
          cwd: this.appPath,
          windowsHide: true,
          env: {
            ...process.env,
            PIP_CACHE_DIR: pipCachePath,
            PIP_DISABLE_PIP_VERSION_CHECK: '1',
            PYTHONUTF8: '1'
          }
        }
      );

      const pushLine = (streamName: 'stdout' | 'stderr', rawLine: string) => {
        const line = formatInstallerLine(rawLine);

        if (!line) {
          return;
        }

        recentLines.push(line);

        if (recentLines.length > MAX_PROGRESS_LINES) {
          recentLines.shift();
        }

        this.logger.info({ stream: streamName, line }, 'Deferred Python provisioner output');
        onProgress?.({
          status: 'Installing Python packages',
          detail: line,
          progress: null
        });
      };

      const flushBuffer = (streamName: 'stdout' | 'stderr', final = false) => {
        const source = streamName === 'stdout' ? stdoutBuffer : stderrBuffer;
        const lines = source.split(/\r?\n/u);
        const remainder = final ? '' : (lines.pop() ?? '');

        for (const line of lines) {
          pushLine(streamName, line);
        }

        if (streamName === 'stdout') {
          stdoutBuffer = remainder;
        } else {
          stderrBuffer = remainder;
        }
      };

      installProcess.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += Buffer.from(chunk).toString('utf8');
        flushBuffer('stdout');
      });

      installProcess.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += Buffer.from(chunk).toString('utf8');
        flushBuffer('stderr');
      });

      installProcess.on('error', (error) => {
        reject(error);
      });

      installProcess.on('close', (code) => {
        flushBuffer('stdout', true);
        flushBuffer('stderr', true);

        if (code === 0) {
          resolve();
          return;
        }

        const summary =
          recentLines.at(-1) ??
          'Deferred Python dependency installation failed before completion.';
        reject(new Error(summary));
      });
    });
  }
}
