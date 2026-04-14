import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type LoggerOptions } from 'pino';
import { APP_PACKAGE_NAME } from '@bridge/branding';

export interface CreateLoggerOptions {
  logDirectory?: string | null;
  logFileName?: string;
  syncFileWrites?: boolean;
}

function createFileDestination(options: CreateLoggerOptions) {
  if (!options.logDirectory) {
    return null;
  }

  try {
    const resolvedDirectory = path.resolve(options.logDirectory);
    mkdirSync(resolvedDirectory, { recursive: true });

    return pino.destination({
      dest: path.join(resolvedDirectory, options.logFileName ?? 'app.log'),
      sync: options.syncFileWrites ?? false
    });
  } catch (error) {
    process.stderr.write(
      `[${APP_PACKAGE_NAME}] Unable to initialize file logging: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );

    return null;
  }
}

export function createLogger(scope?: string, options: CreateLoggerOptions = {}) {
  const loggerOptions: LoggerOptions = {
    name: APP_PACKAGE_NAME,
    level: process.env.LOG_LEVEL ?? 'info',
    base: scope ? { scope } : null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        '*.token',
        '*.authorization',
        '*.Authorization',
        '*.apiKey',
        '*.secret'
      ],
      remove: true
    }
  };
  const fileDestination = createFileDestination(options);

  if (!fileDestination) {
    return pino(loggerOptions);
  }

  return pino(
    loggerOptions,
    pino.multistream([
      { stream: process.stdout },
      { stream: fileDestination }
    ])
  );
}
