import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { looksLikeStructuredPath } from '@bridge/path-prompt';

/**
 * Directories to skip when walking the workspace tree.
 * Merged superset of both service.ts and tools/index.ts ignore lists.
 * All values are lowercase — compare with `.toLowerCase()`.
 */
export const IGNORED_DIRECTORY_NAMES = new Set([
  // JS/TS
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.vite', '.parcel-cache', 'bower_components', '.yarn',
  // Python
  '__pycache__', 'venv', '.venv', 'env', '.tox', '.eggs',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.pytype',
  // Version control
  '.git', '.svn', '.hg',
  // Build artifacts
  'target', 'bin', 'obj', 'pkg',
  // Java/Android/Gradle
  '.gradle', '.m2',
  // iOS/macOS
  'pods', 'deriveddata', 'xcuserdata',
  // Dart/Flutter
  '.dart_tool', '.pub-cache',
  // General
  '.cache', 'coverage', 'tmp', 'temp', 'logs',
  // IDE
  '.idea', '.vs',
  // OS
  '__macosx', '$recycle.bin'
]);

/**
 * Cached file index for a workspace root.
 * Walks the directory tree recursively, skips ignored directories,
 * and caches the flat list of absolute paths with a TTL.
 */
export class WorkspaceFileIndex {
  private cache = new Map<string, { mtimeMs: number; files: string[] }>();
  private ttlMs = 30_000;

  async getFileList(workspaceRoot: string): Promise<string[]> {
    const cached = this.cache.get(workspaceRoot);
    if (cached && Date.now() - cached.mtimeMs < this.ttlMs) {
      return cached.files;
    }

    const files: string[] = [];
    const pending = [workspaceRoot];

    while (pending.length > 0) {
      const dir = pending.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
            pending.push(full);
          }
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    }

    this.cache.set(workspaceRoot, { mtimeMs: Date.now(), files });
    return files;
  }

  async findFilesByBasename(workspaceRoot: string, basename: string): Promise<string[]> {
    const files = await this.getFileList(workspaceRoot);
    const lowerBasename = basename.toLowerCase();
    return files.filter((f) => path.basename(f).toLowerCase() === lowerBasename);
  }

  invalidate(workspaceRoot?: string): void {
    if (workspaceRoot) {
      this.cache.delete(workspaceRoot);
    } else {
      this.cache.clear();
    }
  }
}

export const workspaceFileIndex = new WorkspaceFileIndex();

/**
 * Resolve a bare filename to an absolute path by searching the workspace tree.
 *
 * Returns the resolved absolute path if exactly one match is found.
 * Throws with a disambiguation list if multiple matches are found.
 * Throws "not found" if zero matches.
 * Returns `null` if the candidate is not a bare filename (has path separators
 * or looks like a structured path).
 */
export async function resolveBareFilename(
  candidatePath: string,
  workspaceRoot: string
): Promise<string | null> {
  // Only resolve bare filenames — paths with separators are intentional
  if (/[\\/]/.test(candidatePath) || looksLikeStructuredPath(candidatePath)) {
    return null;
  }

  const matches = await workspaceFileIndex.findFilesByBasename(workspaceRoot, candidatePath);

  if (matches.length === 0) {
    throw new Error(
      `File \`${candidatePath}\` was not found in the workspace. ` +
        `Use workspace-lister to see available files, or provide the full path.`
    );
  }

  if (matches.length === 1) {
    return matches[0]!;
  }

  const relativePaths = matches.map((m) => path.relative(workspaceRoot, m));
  throw new Error(
    `Multiple files match \`${candidatePath}\`: ${relativePaths.join(', ')}. Please specify the full path.`
  );
}
