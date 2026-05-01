import type { DatabaseManager } from '@bridge/db/database';
import type {
  CreatePersonaInput,
  PersonaDefinition,
  UpdatePersonaInput
} from '@bridge/ipc/contracts';
import { personaDefinitionSchema } from '@bridge/ipc/contracts';

function nowIso() {
  return new Date().toISOString();
}

function slugifyPersonaId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

function truncatePersonaId(value: string, maxLength = 80) {
  return value.slice(0, maxLength).replace(/-+$/u, '');
}

interface PersonaRow {
  id: string;
  name: string;
  prompt: string;
  source: PersonaDefinition['source'];
  created_at: string;
  updated_at: string;
}

export class PersonaRepository {
  constructor(private readonly database: DatabaseManager) {}

  private generatePersonaId(name: string): string {
    const baseId = truncatePersonaId(slugifyPersonaId(name) || 'persona');
    let nextId = baseId;
    let suffix = 2;

    while (this.getById(nextId)) {
      const suffixText = `-${suffix}`;
      const truncatedBase = truncatePersonaId(baseId, 80 - suffixText.length) || 'persona';
      nextId = `${truncatedBase}${suffixText}`;
      suffix += 1;
    }

    return nextId;
  }

  list(): PersonaDefinition[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          name,
          prompt,
          source,
          created_at,
          updated_at
        FROM personas
        ORDER BY lower(name) ASC, created_at ASC
      `)
      .all() as unknown as PersonaRow[];

    return rows.map((row) => this.parsePersonaRow(row));
  }

  getById(personaId: string): PersonaDefinition | null {
    const row = this.database.connection
      .prepare(`
        SELECT
          id,
          name,
          prompt,
          source,
          created_at,
          updated_at
        FROM personas
        WHERE id = ?
        LIMIT 1
      `)
      .get(personaId) as PersonaRow | undefined;

    return row ? this.parsePersonaRow(row) : null;
  }

  replaceBuiltinPersonas(personas: PersonaDefinition[]): void {
    const connection = this.database.connection;
    const builtinIds = personas.map((persona) => persona.id);

    connection.exec('BEGIN');

    try {
      if (builtinIds.length > 0) {
        const placeholders = builtinIds.map(() => '?').join(', ');
        connection
          .prepare(
            `DELETE FROM personas WHERE source = 'builtin' AND id NOT IN (${placeholders})`
          )
          .run(...builtinIds);
      } else {
        connection.prepare(`DELETE FROM personas WHERE source = 'builtin'`).run();
      }

      for (const persona of personas) {
        const existing = this.getById(persona.id);
        const createdAt = existing?.createdAt ?? nowIso();
        const updatedAt = nowIso();

        connection
          .prepare(`
            INSERT INTO personas (
              id,
              name,
              prompt,
              source,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, 'builtin', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              prompt = excluded.prompt,
              source = excluded.source,
              updated_at = excluded.updated_at
          `)
          .run(
            persona.id,
            persona.name,
            persona.prompt,
            createdAt,
            updatedAt
          );
      }

      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  createUserPersona(input: CreatePersonaInput): PersonaDefinition {
    const personaId = this.generatePersonaId(input.name);
    const createdAt = nowIso();

    this.database.connection
      .prepare(`
        INSERT INTO personas (
          id,
          name,
          prompt,
          source,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 'user', ?, ?)
      `)
      .run(
        personaId,
        input.name.trim(),
        input.prompt.trim(),
        createdAt,
        createdAt
      );

    return this.getById(personaId) ?? this.parsePersonaRow({
      id: personaId,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      source: 'user',
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  updateUserPersona(input: UpdatePersonaInput): PersonaDefinition {
    const existing = this.getById(input.personaId);

    if (!existing) {
      throw new Error(`Persona "${input.personaId}" was not found.`);
    }

    if (existing.source === 'builtin') {
      throw new Error(`Built-in persona "${input.personaId}" is read-only.`);
    }

    const updatedAt = nowIso();

    this.database.connection
      .prepare(`
        UPDATE personas
        SET
          name = ?,
          prompt = ?,
          updated_at = ?
        WHERE id = ? AND source = 'user'
      `)
      .run(
        input.name.trim(),
        input.prompt.trim(),
        updatedAt,
        input.personaId
      );

    return this.getById(input.personaId) ?? existing;
  }

  deleteUserPersona(personaId: string): void {
    const existing = this.getById(personaId);

    if (!existing) {
      throw new Error(`Persona "${personaId}" was not found.`);
    }

    if (existing.source === 'builtin') {
      throw new Error(`Built-in persona "${personaId}" cannot be deleted.`);
    }

    this.database.connection
      .prepare(`DELETE FROM personas WHERE id = ? AND source = 'user'`)
      .run(personaId);
  }

  private parsePersonaRow(row: PersonaRow): PersonaDefinition {
    return personaDefinitionSchema.parse({
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
