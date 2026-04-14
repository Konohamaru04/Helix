import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ChatRepository', () => {
  it('creates a default workspace and supports FTS conversation search', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-'));
    tempDirectories.push(directory);

    const database = new DatabaseManager(
      path.join(directory, 'ollama-desktop.sqlite'),
      createLogger('repository-test')
    );
    try {
      database.initialize();

      const repository = new ChatRepository(database);
      const workspace = repository.ensureDefaultWorkspace();
      const conversation = repository.createConversation({
        prompt: 'Searchable chat',
        workspaceId: workspace.id
      });

      repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Tell me about markdown rendering',
        attachments: [],
        status: 'completed'
      });

      const results = repository.searchConversations('markdown');

      expect(workspace.name).toBe('General');
      expect(results).toHaveLength(1);
      expect(results[0]?.conversation.id).toBe(conversation.id);
      expect(results[0]?.snippet).toContain('markdown');
    } finally {
      database.close();
    }
  });

  it('deletes a conversation and cascades its messages', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-delete-'));
    tempDirectories.push(directory);

    const database = new DatabaseManager(
      path.join(directory, 'ollama-desktop.sqlite'),
      createLogger('repository-delete-test')
    );
    try {
      database.initialize();

      const repository = new ChatRepository(database);
      const workspace = repository.ensureDefaultWorkspace();
      const conversation = repository.createConversation({
        prompt: 'Delete me',
        workspaceId: workspace.id
      });
      const message = repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Temporary message',
        attachments: [],
        status: 'completed'
      });

      repository.deleteConversation(conversation.id);

      expect(repository.getConversation(conversation.id)).toBeNull();
      expect(repository.getMessage(message.id)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('stores fresh attachment row ids when the same attachment is reused across messages', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-attachments-'));
    tempDirectories.push(directory);

    const database = new DatabaseManager(
      path.join(directory, 'ollama-desktop.sqlite'),
      createLogger('repository-attachments-test')
    );
    try {
      database.initialize();

      const repository = new ChatRepository(database);
      const workspace = repository.ensureDefaultWorkspace();
      const conversation = repository.createConversation({
        prompt: 'Attachment reuse',
        workspaceId: workspace.id
      });
      const attachment = {
        id: '70000000-0000-4000-8000-000000000001',
        fileName: 'reference.png',
        filePath: 'E:/images/reference.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        extractedText: null,
        createdAt: '2026-04-09T00:00:00.000Z'
      };

      const firstMessage = repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Describe this image.',
        attachments: [attachment],
        status: 'completed'
      });
      const secondMessage = repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Describe it again.',
        attachments: [attachment],
        status: 'completed'
      });

      expect(firstMessage.attachments[0]?.id).not.toBe(attachment.id);
      expect(secondMessage.attachments[0]?.id).not.toBe(attachment.id);
      expect(secondMessage.attachments[0]?.id).not.toBe(firstMessage.attachments[0]?.id);
      expect(repository.listMessages(conversation.id)).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('keeps same-timestamp messages in insertion order and only deletes turns after the target row', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-ordering-'));
    tempDirectories.push(directory);

    const database = new DatabaseManager(
      path.join(directory, 'ollama-desktop.sqlite'),
      createLogger('repository-ordering-test')
    );
    try {
      database.initialize();

      const repository = new ChatRepository(database);
      const workspace = repository.ensureDefaultWorkspace();
      const conversation = repository.createConversation({
        prompt: 'Ordering test',
        workspaceId: workspace.id
      });
      const sharedTimestamp = '2026-04-09T00:00:00.000Z';

      const userMessage = repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Prompt',
        attachments: [],
        status: 'completed',
        createdAt: sharedTimestamp,
        updatedAt: sharedTimestamp
      });
      const assistantMessage = repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Reply',
        attachments: [],
        status: 'completed',
        createdAt: sharedTimestamp,
        updatedAt: sharedTimestamp
      });

      expect(repository.listMessages(conversation.id).map((message) => message.id)).toEqual([
        userMessage.id,
        assistantMessage.id
      ]);

      repository.deleteMessagesAfter(assistantMessage.id, { includeTarget: true });

      expect(repository.listMessages(conversation.id).map((message) => message.id)).toEqual([
        userMessage.id
      ]);
    } finally {
      database.close();
    }
  });
});
