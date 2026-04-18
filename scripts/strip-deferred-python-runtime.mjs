import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonRuntime = path.join(projectRoot, 'python_embeded', 'python.exe');
const requirementsPath = path.join(
  projectRoot,
  'config',
  'python-deferred-requirements.txt'
);

if (!existsSync(pythonRuntime)) {
  throw new Error(`Bundled runtime not found at ${pythonRuntime}`);
}

if (!existsSync(requirementsPath)) {
  throw new Error(`Deferred requirements file not found at ${requirementsPath}`);
}

const requirementNames = readFileSync(requirementsPath, 'utf8')
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => {
    const match = line.match(/^([A-Za-z0-9_.-]+)/u);

    if (!match) {
      throw new Error(`Unable to parse requirement line: ${line}`);
    }

    return match[1];
  });

if (requirementNames.length === 0) {
  console.log('No deferred Python packages configured. Nothing to strip.');
  process.exit(0);
}

console.log(`Stripping deferred Python packages from ${pythonRuntime}`);
console.log(`Packages: ${requirementNames.join(', ')}`);

const result = spawnSync(
  pythonRuntime,
  ['-m', 'pip', 'uninstall', '-y', ...requirementNames],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true
  }
);

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
