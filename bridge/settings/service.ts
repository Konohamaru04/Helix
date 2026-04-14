import type { DatabaseManager } from '@bridge/db/database';
import {
  type UpdateUserSettings,
  type UserSettings,
  updateUserSettingsSchema,
  userSettingsSchema
} from '@bridge/ipc/contracts';
import type { Logger } from 'pino';

export const defaultUserSettings: UserSettings = {
  textInferenceBackend: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nvidiaApiKey: '',
  defaultModel: '',
  codingModel: '',
  visionModel: '',
  imageGenerationModel: 'builtin:placeholder',
  additionalModelsDirectory: null,
  videoGenerationModel: '',
  pythonPort: 8765,
  theme: 'system'
};

const settingsKeys = Object.keys(defaultUserSettings) as Array<keyof UserSettings>;

export class SettingsService {
  constructor(
    private readonly database: DatabaseManager,
    private readonly logger: Logger
  ) {}

  ensureDefaults(): UserSettings {
    const current = this.readRawSettings();
    const now = new Date().toISOString();

    for (const key of settingsKeys) {
      if (key in current) {
        continue;
      }

      this.database.connection
        .prepare(`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES (?, ?, ?)
        `)
        .run(key, JSON.stringify(defaultUserSettings[key]), now);
    }

    return this.get();
  }

  get(): UserSettings {
    const rawSettings = this.readRawSettings();

    return userSettingsSchema.parse({
      ...defaultUserSettings,
      ...rawSettings
    });
  }

  update(patch: UpdateUserSettings): UserSettings {
    const validatedPatch = updateUserSettingsSchema.parse(patch);
    const nextSettings = userSettingsSchema.parse({
      ...this.get(),
      ...validatedPatch
    });
    const updatedAt = new Date().toISOString();

    for (const key of settingsKeys) {
      this.database.connection
        .prepare(`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `)
        .run(key, JSON.stringify(nextSettings[key]), updatedAt);
    }

    this.logger.info(
      { updatedKeys: Object.keys(validatedPatch) },
      'Updated persisted settings'
    );

    return nextSettings;
  }

  private readRawSettings(): Record<string, unknown> {
    const rows = this.database.connection
      .prepare('SELECT key, value_json FROM settings')
      .all() as Array<{ key: string; value_json: string }>;

    const accumulator: Record<string, unknown> = {};

    for (const row of rows) {
      accumulator[row.key] = JSON.parse(row.value_json);
    }

    return accumulator;
  }
}
