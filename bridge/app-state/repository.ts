import type { DatabaseManager } from '@bridge/db/database';

export interface PersistedWindowBounds {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  isMaximized: boolean;
}

const WINDOW_BOUNDS_KEY = 'mainWindow.bounds';

export class AppStateRepository {
  constructor(private readonly database: DatabaseManager) {}

  getJson<T>(key: string): T | null {
    const row = this.database.connection
      .prepare('SELECT value_json FROM app_state WHERE key = ?')
      .get(key) as { value_json: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    const updatedAt = new Date().toISOString();
    this.database.connection
      .prepare(
        `
          INSERT INTO app_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `
      )
      .run(key, JSON.stringify(value), updatedAt);
  }

  getWindowBounds(): PersistedWindowBounds | null {
    const value = this.getJson<Partial<PersistedWindowBounds>>(WINDOW_BOUNDS_KEY);
    if (!value || typeof value !== 'object') {
      return null;
    }

    const width = Number.isFinite(value.width) ? Number(value.width) : null;
    const height = Number.isFinite(value.height) ? Number(value.height) : null;
    if (width === null || height === null || width < 320 || height < 240) {
      return null;
    }

    return {
      width,
      height,
      x: Number.isFinite(value.x) ? Number(value.x) : null,
      y: Number.isFinite(value.y) ? Number(value.y) : null,
      isMaximized: value.isMaximized === true
    };
  }

  setWindowBounds(bounds: PersistedWindowBounds): void {
    this.setJson(WINDOW_BOUNDS_KEY, bounds);
  }

  getDraft(conversationId: string): string | null {
    const row = this.database.connection
      .prepare('SELECT prompt FROM conversation_drafts WHERE conversation_id = ?')
      .get(conversationId) as { prompt: string } | undefined;

    return row ? row.prompt : null;
  }

  setDraft(conversationId: string, prompt: string): void {
    const updatedAt = new Date().toISOString();
    this.database.connection
      .prepare(
        `
          INSERT INTO conversation_drafts (conversation_id, prompt, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            prompt = excluded.prompt,
            updated_at = excluded.updated_at
        `
      )
      .run(conversationId, prompt, updatedAt);
  }

  clearDraft(conversationId: string): void {
    this.database.connection
      .prepare('DELETE FROM conversation_drafts WHERE conversation_id = ?')
      .run(conversationId);
  }
}
