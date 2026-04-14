import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { SettingsService, defaultUserSettings } from '@bridge/settings/service';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DatabaseManager', () => {
  it('enables WAL mode and seeds default settings', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-db-'));
    tempDirectories.push(directory);

    const database = new DatabaseManager(
      path.join(directory, 'ollama-desktop.sqlite'),
      createLogger('database-test')
    );
    database.initialize();

    const pragmaRow = database.connection
      .prepare('PRAGMA journal_mode')
      .get() as { journal_mode: string };

    expect(pragmaRow.journal_mode.toLowerCase()).toBe('wal');

    const settingsService = new SettingsService(database, createLogger('settings-test'));
    expect(settingsService.ensureDefaults()).toEqual(defaultUserSettings);
    const embeddingTable = database.connection
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'knowledge_chunk_embeddings'
      `)
      .get() as { name: string } | undefined;
    const memorySummaryTable = database.connection
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'conversation_memory_summaries'
      `)
      .get() as { name: string } | undefined;
    const generationJobsTable = database.connection
      .prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'generation_jobs'
      `)
      .get() as { name: string; sql: string } | undefined;
    const generationArtifactsTable = database.connection
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'generation_artifacts'
      `)
      .get() as { name: string } | undefined;
    const generationReferenceImagesTable = database.connection
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'generation_reference_images'
      `)
      .get() as { name: string } | undefined;
    const toolInvocationOutputColumn = database.connection
      .prepare(`
        SELECT name
        FROM pragma_table_info('tool_invocations')
        WHERE name = 'output_text'
      `)
      .get() as { name: string } | undefined;

    expect(embeddingTable?.name).toBe('knowledge_chunk_embeddings');
    expect(memorySummaryTable?.name).toBe('conversation_memory_summaries');
    expect(generationJobsTable?.name).toBe('generation_jobs');
    expect(generationJobsTable?.sql).toContain("'comfyui'");
    expect(generationArtifactsTable?.name).toBe('generation_artifacts');
    expect(generationReferenceImagesTable?.name).toBe('generation_reference_images');
    expect(toolInvocationOutputColumn?.name).toBe('output_text');
    database.close();
  });
});
