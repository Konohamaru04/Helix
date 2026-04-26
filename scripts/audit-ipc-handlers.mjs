#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const handlersPath = join(repoRoot, 'electron', 'ipc', 'register-handlers.ts');
const mainPath = join(repoRoot, 'electron', 'main.ts');

const sources = [handlersPath, mainPath].map((path) => ({
  path,
  text: readFileSync(path, 'utf8')
}));

const handlerPattern = /ipcMain\.handle\(\s*([A-Za-z0-9_.]+)\s*,\s*(?:async\s+)?\(([^)]*)\)\s*=>/g;

const violations = [];

for (const { path, text } of sources) {
  let match;
  while ((match = handlerPattern.exec(text)) !== null) {
    const channel = match[1];
    const params = match[2];
    const start = match.index;
    // Look at the next ~600 chars for either .parse(payload) usage or zero-arg handler
    const window = text.slice(start, start + 600);
    const hasPayloadParam = /,\s*([A-Za-z_][A-Za-z0-9_]*)\b/.test(params);
    if (!hasPayloadParam) {
      // Handlers with no payload are inherently safe.
      continue;
    }
    const usesZodParse = /[A-Za-z_][A-Za-z0-9_]*Schema\.parse\(/.test(window);
    if (!usesZodParse) {
      violations.push({
        path,
        channel,
        snippetStart: start
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `audit-ipc-handlers: ${violations.length} IPC handler(s) accept a payload but do not call a *Schema.parse on it:`
  );
  for (const v of violations) {
    console.error(`  - ${v.channel} (${v.path})`);
  }
  process.exit(1);
}

console.log(
  `audit-ipc-handlers: OK — every payload-accepting ipcMain.handle in main + register-handlers calls a zod *Schema.parse.`
);
