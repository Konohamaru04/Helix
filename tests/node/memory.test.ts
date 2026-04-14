import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { TurnMetadataService } from '@bridge/chat/turn-metadata';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { MemoryService } from '@bridge/memory';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-memory-'));
  tempDirectories.push(directory);
  const logger = createLogger('memory-test');
  const database = new DatabaseManager(path.join(directory, 'ollama-desktop.sqlite'), logger);
  database.initialize();

  const repository = new ChatRepository(database);
  const workspace = repository.ensureDefaultWorkspace();
  const conversation = repository.createConversation({
    prompt: 'Kick off memory testing',
    workspaceId: workspace.id
  });
  const turnMetadataService = new TurnMetadataService(database);
  const memoryService = new MemoryService(repository, turnMetadataService);

  return { database, repository, conversation, memoryService };
}

describe('MemoryService', () => {
  it('summarizes older turns and keeps recent ones raw', () => {
    const harness = createHarness();

    try {
      for (let index = 0; index < 10; index += 1) {
        harness.repository.createMessage({
          conversationId: harness.conversation.id,
          role: 'user',
          content: `User prompt ${index + 1}`,
          status: 'completed'
        });
        harness.repository.createMessage({
          conversationId: harness.conversation.id,
          role: 'assistant',
          content: `Assistant answer ${index + 1}`,
          status: 'completed'
        });
      }

      const messages = harness.repository.listMessages(harness.conversation.id);
      const memoryContext = harness.memoryService.buildConversationMemoryContext(
        harness.conversation.id,
        messages
      );
      const storedSummary = harness.repository.getConversationMemorySummary(
        harness.conversation.id
      );

      expect(memoryContext.summaryText).toContain('User: User prompt');
      expect(memoryContext.summarizedMessageIds.length).toBeGreaterThan(0);
      expect(memoryContext.recentMessages.length).toBeLessThan(messages.length);
      expect(storedSummary?.messageCount).toBe(memoryContext.summarizedMessageIds.length);
      expect(storedSummary?.summaryText).toBe(memoryContext.summaryText);
    } finally {
      harness.database.close();
    }
  });
});
