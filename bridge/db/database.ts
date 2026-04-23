import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from 'pino';
import initialMigration from './migrations/001_initial.sql?raw';
import workspaceSearchMigration from './migrations/002_workspace_search.sql?raw';
import messageAttachmentsMigration from './migrations/003_message_attachments.sql?raw';
import routingToolsRagMigration from './migrations/004_routing_tools_rag.sql?raw';
import workspaceRootMigration from './migrations/005_workspace_root.sql?raw';
import embeddingsMemoryMigration from './migrations/006_embeddings_memory.sql?raw';
import generationJobsMigration from './migrations/007_generation_jobs.sql?raw';
import generationWorkflowInputsMigration from './migrations/008_generation_workflow_inputs.sql?raw';
import generationBackendComfyUiMigration from './migrations/009_generation_job_backend_comfyui.sql?raw';
import capabilitySurfaceMigration from './migrations/010_capability_surface.sql?raw';
import toolInvocationOutputTextMigration from './migrations/011_tool_invocation_output_text.sql?raw';
import taskSequenceMigration from './migrations/012_task_sequence.sql?raw';
import workspaceScopedTasksMigration from './migrations/013_workspace_scoped_tasks.sql?raw';
import skillRegistryMigration from './migrations/015_skill_registry.sql?raw';
import generationVideoJobsMigration from './migrations/016_generation_video_jobs.sql?raw';

const bundledMigrations = [
  {
    version: '001_initial.sql',
    sql: initialMigration
  },
  {
    version: '002_workspace_search.sql',
    sql: workspaceSearchMigration
  },
  {
    version: '003_message_attachments.sql',
    sql: messageAttachmentsMigration
  },
  {
    version: '004_routing_tools_rag.sql',
    sql: routingToolsRagMigration
  },
  {
    version: '005_workspace_root.sql',
    sql: workspaceRootMigration
  },
  {
    version: '006_embeddings_memory.sql',
    sql: embeddingsMemoryMigration
  },
  {
    version: '007_generation_jobs.sql',
    sql: generationJobsMigration
  },
  {
    version: '008_generation_workflow_inputs.sql',
    sql: generationWorkflowInputsMigration
  },
  {
    version: '009_generation_job_backend_comfyui.sql',
    sql: generationBackendComfyUiMigration
  },
  {
    version: '010_capability_surface.sql',
    sql: capabilitySurfaceMigration
  },
  {
    version: '011_tool_invocation_output_text.sql',
    sql: toolInvocationOutputTextMigration
  },
  {
    version: '012_task_sequence.sql',
    sql: taskSequenceMigration
  },
  {
    version: '013_workspace_scoped_tasks.sql',
    sql: workspaceScopedTasksMigration
  },
  {
    version: '015_skill_registry.sql',
    sql: skillRegistryMigration
  },
  {
    version: '016_generation_video_jobs.sql',
    sql: generationVideoJobsMigration
  }
];

export class DatabaseManager {
  #connection: DatabaseSync | null = null;

  constructor(
    public readonly databasePath: string,
    private readonly logger: Logger
  ) {}

  initialize(): void {
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.#connection = new DatabaseSync(this.databasePath);

    const connection = this.connection;
    connection.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);

    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    this.runMigrations();
    this.logger.info({ databasePath: this.databasePath }, 'SQLite initialized');
  }

  get connection(): DatabaseSync {
    if (!this.#connection) {
      throw new Error('Database has not been initialized.');
    }

    return this.#connection;
  }

  close(): void {
    this.#connection?.close();
    this.#connection = null;
  }

  private runMigrations(): void {
    const connection = this.connection;
    const appliedVersions = new Set(
      (connection
        .prepare('SELECT version FROM schema_migrations')
        .all() as Array<{ version: string }>).map((row) => row.version)
    );

    for (const migration of bundledMigrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      const appliedAt = new Date().toISOString();

      connection.exec('BEGIN');

      try {
        connection.exec(migration.sql);
        connection
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, appliedAt);
        connection.exec('COMMIT');
        this.logger.info({ migration: migration.version }, 'Applied SQLite migration');
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    }
  }
}
