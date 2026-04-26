import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStateRepository } from '@bridge/app-state/repository';
import { ChatRepository } from '@bridge/chat/repository';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';

const tempDirectories: string[] = [];
const openDatabases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // ignore close errors so cleanup proceeds
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore filesystem cleanup races on Windows
    }
  }
});

function createDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), 'helix-app-state-'));
  tempDirectories.push(directory);
  const database = new DatabaseManager(
    path.join(directory, 'app-state.sqlite'),
    createLogger('app-state-test')
  );
  database.initialize();
  openDatabases.push(database);
  return database;
}

describe('AppStateRepository', () => {
  it('round-trips window bounds and rejects degenerate sizes', () => {
    const database = createDatabase();
    const repository = new AppStateRepository(database);

    expect(repository.getWindowBounds()).toBeNull();

    repository.setWindowBounds({
      width: 1280,
      height: 800,
      x: 100,
      y: 50,
      isMaximized: false
    });
    expect(repository.getWindowBounds()).toEqual({
      width: 1280,
      height: 800,
      x: 100,
      y: 50,
      isMaximized: false
    });

    repository.setJson('mainWindow.bounds', { width: 10, height: 10 });
    expect(repository.getWindowBounds()).toBeNull();
  });

  it('persists conversation drafts and clears them on conversation delete', () => {
    const database = createDatabase();
    const repository = new AppStateRepository(database);
    const chatRepository = new ChatRepository(database);
    chatRepository.ensureDefaultWorkspace();
    const conversation = chatRepository.createConversation({
      prompt: 'Draft test conversation seed prompt',
      workspaceId: null
    });

    expect(repository.getDraft(conversation.id)).toBeNull();

    repository.setDraft(conversation.id, 'in progress prompt');
    expect(repository.getDraft(conversation.id)).toBe('in progress prompt');

    repository.setDraft(conversation.id, 'updated prompt');
    expect(repository.getDraft(conversation.id)).toBe('updated prompt');

    repository.clearDraft(conversation.id);
    expect(repository.getDraft(conversation.id)).toBeNull();

    repository.setDraft(conversation.id, 'will be cascaded away');
    chatRepository.deleteConversation(conversation.id);
    expect(repository.getDraft(conversation.id)).toBeNull();
  });
});
