import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { RagService } from '@bridge/rag';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-rag-'));
  tempDirectories.push(directory);
  const logger = createLogger('rag-test');
  const database = new DatabaseManager(path.join(directory, 'ollama-desktop.sqlite'), logger);
  database.initialize();

  const repository = new ChatRepository(database);
  const workspace = repository.ensureDefaultWorkspace();
  const ragService = new RagService(database, logger);

  return { database, workspace, ragService };
}

describe('RagService', () => {
  it('imports text attachments, skips metadata-only files, and deduplicates repeated content', () => {
    const harness = createHarness();

    try {
      const firstImport = harness.ragService.importAttachments(harness.workspace.id, [
        {
          id: '10000000-0000-4000-8000-000000000001',
          fileName: 'architecture.md',
          filePath: 'E:\\OllamaDesktop\\docs\\architecture.md',
          mimeType: 'text/markdown',
          sizeBytes: 100,
          extractedText: 'Renderer talks only through preload and typed IPC.',
          createdAt: '2026-04-08T00:00:00.000Z'
        },
        {
          id: '10000000-0000-4000-8000-000000000002',
          fileName: 'architecture-copy.md',
          filePath: 'E:\\OllamaDesktop\\docs\\architecture-copy.md',
          mimeType: 'text/markdown',
          sizeBytes: 100,
          extractedText: 'Renderer talks only through preload and typed IPC.',
          createdAt: '2026-04-08T00:00:00.000Z'
        },
        {
          id: '10000000-0000-4000-8000-000000000003',
          fileName: 'image.png',
          filePath: 'E:\\OllamaDesktop\\assets\\image.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          extractedText: null,
          createdAt: '2026-04-08T00:00:00.000Z'
        }
      ]);

      const listedDocuments = harness.ragService.listWorkspaceDocuments(harness.workspace.id);
      const searchResults = harness.ragService.searchWorkspaceKnowledge(
        harness.workspace.id,
        'typed IPC preload',
        4
      );

      expect(firstImport.skippedFiles).toEqual(['image.png']);
      expect(firstImport.documents).toHaveLength(2);
      expect(listedDocuments).toHaveLength(1);
      expect(searchResults[0]?.label).toBe('architecture-copy.md');
      expect(searchResults[0]?.excerpt).toContain('typed IPC');
    } finally {
      harness.database.close();
    }
  });

  it('backfills local embeddings and supports typo-tolerant semantic retrieval', () => {
    const harness = createHarness();

    try {
      harness.ragService.importAttachments(harness.workspace.id, [
        {
          id: '10000000-0000-4000-8000-000000000011',
          fileName: 'preload-guide.md',
          filePath: 'E:\\OllamaDesktop\\docs\\preload-guide.md',
          mimeType: 'text/markdown',
          sizeBytes: 128,
          extractedText:
            'Renderer communication must go through preload and typed IPC contracts.',
          createdAt: '2026-04-08T00:00:00.000Z'
        }
      ]);

      const embeddingRowCount = harness.database.connection
        .prepare('SELECT COUNT(*) AS count FROM knowledge_chunk_embeddings')
        .get() as { count: number };
      const searchResults = harness.ragService.searchWorkspaceKnowledge(
        harness.workspace.id,
        'prelaod typd ipc',
        4
      );

      expect(embeddingRowCount.count).toBeGreaterThan(0);
      expect(searchResults[0]?.label).toBe('preload-guide.md');
      expect(searchResults[0]?.excerpt.toLowerCase()).toContain('preload');
      expect((searchResults[0]?.score ?? 0)).toBeGreaterThan(0);
    } finally {
      harness.database.close();
    }
  });
});
