import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@bridge/logging/logger';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createLogger', () => {
  it('writes structured logs to a file when a log directory is configured', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-logger-'));
    const logDirectory = path.join(directory, 'logs');
    tempDirectories.push(directory);
    const logger = createLogger('logger-test', {
      logDirectory,
      syncFileWrites: true
    });

    logger.info(
      {
        action: 'test-log-write',
        detail: 'persistent log entry'
      },
      'Wrote test log entry'
    );

    const logContents = readFileSync(path.join(logDirectory, 'app.log'), 'utf8');

    expect(logContents).toContain('"scope":"logger-test"');
    expect(logContents).toContain('"action":"test-log-write"');
    expect(logContents).toContain('"detail":"persistent log entry"');
    expect(logContents).toContain('"msg":"Wrote test log entry"');
  });
});
