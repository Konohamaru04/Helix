#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(repoRoot, 'package.json');

function usage() {
  console.error(
    [
      'Usage: node scripts/bump-version.mjs <newVersion> [--no-tag]',
      '',
      '  - Updates package.json version (must be valid semver, no leading v).',
      '  - Stages package.json + package-lock.json (if present).',
      '  - Commits with message "release: vX.Y.Z" unless --no-commit.',
      '  - Tags vX.Y.Z unless --no-tag.',
      '',
      'Does NOT push. Run "git push --follow-tags" once you are ready.'
    ].join('\n')
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) usage();

const versionArg = args[0];
const noTag = args.includes('--no-tag');
const noCommit = args.includes('--no-commit');

if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(versionArg)) {
  console.error(`Invalid semver: "${versionArg}"`);
  usage();
}

const pkgRaw = readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(pkgRaw);
const previous = pkg.version;
if (previous === versionArg) {
  console.error(`package.json is already at ${versionArg}; nothing to do.`);
  process.exit(0);
}

pkg.version = versionArg;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Updated package.json version: ${previous} -> ${versionArg}`);

const lockPath = join(repoRoot, 'package-lock.json');
let lockUpdated = false;
try {
  const lockRaw = readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(lockRaw);
  let changed = false;
  if (lock.version && lock.version !== versionArg) {
    lock.version = versionArg;
    changed = true;
  }
  if (lock.packages && lock.packages[''] && lock.packages[''].version) {
    lock.packages[''].version = versionArg;
    changed = true;
  }
  if (changed) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    lockUpdated = true;
    console.log('Updated package-lock.json version field.');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.warn(`Could not update package-lock.json: ${error.message ?? error}`);
  }
}

if (noCommit) {
  console.log('--no-commit set; leaving working tree dirty.');
  process.exit(0);
}

const gitArgs = ['add', 'package.json'];
if (lockUpdated) gitArgs.push('package-lock.json');
execSync(`git ${gitArgs.join(' ')}`, { stdio: 'inherit', cwd: repoRoot });
execSync(`git commit -m "release: v${versionArg}"`, { stdio: 'inherit', cwd: repoRoot });

if (!noTag) {
  execSync(`git tag -a v${versionArg} -m "Helix v${versionArg}"`, {
    stdio: 'inherit',
    cwd: repoRoot
  });
  console.log(`Tagged v${versionArg}.`);
}

console.log('Done. Push with: git push --follow-tags');
