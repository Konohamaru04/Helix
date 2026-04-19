import type { DatabaseManager } from '@bridge/db/database';
import type {
  CreateSkillInput,
  SkillDefinition,
  UpdateSkillInput
} from '@bridge/ipc/contracts';
import { skillDefinitionSchema } from '@bridge/ipc/contracts';

function nowIso() {
  return new Date().toISOString();
}

function slugifySkillId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

function truncateSkillId(value: string, maxLength = 80) {
  return value.slice(0, maxLength).replace(/-+$/u, '');
}

interface SkillRow {
  id: string;
  title: string;
  description: string;
  prompt: string;
  source: SkillDefinition['source'];
  read_only: number;
  origin_path: string | null;
  created_at: string;
  updated_at: string;
}

export class SkillRepository {
  constructor(private readonly database: DatabaseManager) {}

  private generateSkillId(title: string): string {
    const baseId = truncateSkillId(slugifySkillId(title) || 'skill');
    let nextId = baseId;
    let suffix = 2;

    while (this.getById(nextId)) {
      const suffixText = `-${suffix}`;
      const truncatedBase = truncateSkillId(baseId, 80 - suffixText.length) || 'skill';
      nextId = `${truncatedBase}${suffixText}`;
      suffix += 1;
    }

    return nextId;
  }

  list(): SkillDefinition[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          title,
          description,
          prompt,
          source,
          read_only,
          origin_path,
          created_at,
          updated_at
        FROM skill_definitions
        ORDER BY lower(title) ASC, created_at ASC
      `)
      .all() as unknown as SkillRow[];

    return rows.map((row) => this.parseSkillRow(row));
  }

  getById(skillId: string): SkillDefinition | null {
    const row = this.database.connection
      .prepare(`
        SELECT
          id,
          title,
          description,
          prompt,
          source,
          read_only,
          origin_path,
          created_at,
          updated_at
        FROM skill_definitions
        WHERE id = ?
        LIMIT 1
      `)
      .get(skillId) as SkillRow | undefined;

    return row ? this.parseSkillRow(row) : null;
  }

  replaceBuiltinSkills(
    skills: Array<
      SkillDefinition & {
        originPath?: string | null;
      }
    >
  ): void {
    const connection = this.database.connection;
    const builtinIds = skills.map((skill) => skill.id);

    connection.exec('BEGIN');

    try {
      if (builtinIds.length > 0) {
        const placeholders = builtinIds.map(() => '?').join(', ');
        connection
          .prepare(
            `DELETE FROM skill_definitions WHERE source = 'builtin' AND id NOT IN (${placeholders})`
          )
          .run(...builtinIds);
      } else {
        connection.prepare(`DELETE FROM skill_definitions WHERE source = 'builtin'`).run();
      }

      for (const skill of skills) {
        const existing = this.getById(skill.id);
        const createdAt = existing?.createdAt ?? nowIso();
        const updatedAt = nowIso();

        connection
          .prepare(`
            INSERT INTO skill_definitions (
              id,
              title,
              description,
              prompt,
              source,
              read_only,
              origin_path,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, 'builtin', 1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              prompt = excluded.prompt,
              source = excluded.source,
              read_only = excluded.read_only,
              origin_path = excluded.origin_path,
              updated_at = excluded.updated_at
          `)
          .run(
            skill.id,
            skill.title,
            skill.description,
            skill.prompt,
            skill.originPath ?? null,
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

  importUserSkills(
    skills: Array<
      SkillDefinition & {
        originPath?: string | null;
      }
    >
  ): void {
    const insertStatement = this.database.connection.prepare(`
      INSERT OR IGNORE INTO skill_definitions (
        id,
        title,
        description,
        prompt,
        source,
        read_only,
        origin_path,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'user', 0, ?, ?, ?)
    `);

    for (const skill of skills) {
      const createdAt = nowIso();
      insertStatement.run(
        skill.id,
        skill.title,
        skill.description,
        skill.prompt,
        skill.originPath ?? null,
        createdAt,
        createdAt
      );
    }
  }

  createUserSkill(input: CreateSkillInput): SkillDefinition {
    const skillId = this.generateSkillId(input.title);
    const createdAt = nowIso();

    this.database.connection
      .prepare(`
        INSERT INTO skill_definitions (
          id,
          title,
          description,
          prompt,
          source,
          read_only,
          origin_path,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'user', 0, NULL, ?, ?)
      `)
      .run(
        skillId,
        input.title.trim(),
        input.description.trim(),
        input.prompt.trim(),
        createdAt,
        createdAt
      );

    return this.getById(skillId) ?? this.parseSkillRow({
      id: skillId,
      title: input.title.trim(),
      description: input.description.trim(),
      prompt: input.prompt.trim(),
      source: 'user',
      read_only: 0,
      origin_path: null,
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  updateUserSkill(input: UpdateSkillInput): SkillDefinition {
    const existing = this.getById(input.skillId);

    if (!existing) {
      throw new Error(`Skill "${input.skillId}" was not found.`);
    }

    if (existing.readOnly) {
      throw new Error(`Built-in skill "${input.skillId}" is read-only.`);
    }

    const updatedAt = nowIso();

    this.database.connection
      .prepare(`
        UPDATE skill_definitions
        SET
          title = ?,
          description = ?,
          prompt = ?,
          updated_at = ?
        WHERE id = ? AND source = 'user'
      `)
      .run(
        input.title.trim(),
        input.description.trim(),
        input.prompt.trim(),
        updatedAt,
        input.skillId
      );

    return this.getById(input.skillId) ?? existing;
  }

  deleteUserSkill(skillId: string): void {
    const existing = this.getById(skillId);

    if (!existing) {
      throw new Error(`Skill "${skillId}" was not found.`);
    }

    if (existing.readOnly) {
      throw new Error(`Built-in skill "${skillId}" cannot be deleted.`);
    }

    this.database.connection
      .prepare(`DELETE FROM skill_definitions WHERE id = ? AND source = 'user'`)
      .run(skillId);
  }

  private parseSkillRow(row: SkillRow): SkillDefinition {
    return skillDefinitionSchema.parse({
      id: row.id,
      title: row.title,
      description: row.description,
      prompt: row.prompt,
      source: row.source,
      readOnly: row.read_only === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
