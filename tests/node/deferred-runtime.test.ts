import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFERRED_PYTHON_SENTINELS,
  formatDeferredPythonInstallerLine,
  getDeferredPythonManifestPath,
  getDeferredPythonRequirementsHash,
  getDeferredPythonSitePackagesPath,
  isDeferredPythonRuntimeReady,
  parseDeferredPythonRequirements
} from '@bridge/python/deferred-runtime';

describe('DeferredPythonRuntimeProvisioner helpers', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();

      if (directory) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('parses the deferred requirements file without comments or blank lines', () => {
    expect(
      parseDeferredPythonRequirements(`
# comment
transformers==5.5.0

tokenizers==0.22.2
      `)
    ).toEqual(['transformers==5.5.0', 'tokenizers==0.22.2']);
  });

  it('summarizes long pip install lines for the splash UI', () => {
    expect(
      formatDeferredPythonInstallerLine(
        'Installing collected packages: urllib3, typing-extensions, simpleeval, shellingham, sentencepiece, safetensors'
      )
    ).toBe('Installing packages (6): urllib3, typing-extensions, simpleeval, shellingham, ...');

    expect(
      formatDeferredPythonInstallerLine(
        'Successfully installed urllib3-2.6.3 typing-extensions-4.15.0 simpleeval-1.0.7 shellingham-1.5.4'
      )
    ).toBe(
      'Installed packages (4): urllib3-2.6.3, typing-extensions-4.15.0, simpleeval-1.0.7, shellingham-1.5.4'
    );
  });

  it('validates the provisioned runtime manifest and sentinel entries', () => {
    const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'helix-deferred-runtime-'));
    temporaryDirectories.push(userDataPath);

    const sitePackagesPath = getDeferredPythonSitePackagesPath(userDataPath);
    mkdirSync(sitePackagesPath, { recursive: true });

    for (const sentinel of DEFERRED_PYTHON_SENTINELS) {
      const sentinelPath = path.join(sitePackagesPath, sentinel);
      mkdirSync(path.dirname(sentinelPath), { recursive: true });

      if (path.extname(sentinel) || sentinel.endsWith('.py')) {
        writeFileSync(sentinelPath, '');
      } else {
        mkdirSync(sentinelPath, { recursive: true });
      }
    }

    const requirementsHash = getDeferredPythonRequirementsHash('transformers==5.5.0\n');
    writeFileSync(
      getDeferredPythonManifestPath(userDataPath),
      JSON.stringify(
        {
          manifestVersion: 1,
          requirementsHash,
          requirements: ['transformers==5.5.0'],
          provisionedAt: '2026-04-19T00:00:00.000Z'
        },
        null,
        2
      )
    );

    expect(isDeferredPythonRuntimeReady(userDataPath, requirementsHash)).toBe(true);
    expect(
      isDeferredPythonRuntimeReady(
        userDataPath,
        getDeferredPythonRequirementsHash('transformers==9.9.9\n')
      )
    ).toBe(false);
  });
});
