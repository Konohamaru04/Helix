import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseManager } from '@bridge/db/database';
import type {
  CreateSkillInput,
  SkillDefinition,
  UpdateSkillInput
} from '@bridge/ipc/contracts';
import { skillDefinitionSchema } from '@bridge/ipc/contracts';
import type { Logger } from 'pino';
import { SkillRepository } from './repository';

function parseFrontmatter(markdown: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const frontmatterMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    return {
      attributes: {},
      body: markdown.trim()
    };
  }

  const rawAttributes = frontmatterMatch[1] ?? '';
  const body = frontmatterMatch[2] ?? '';
  const attributes = rawAttributes.split('\n').reduce<Record<string, string>>(
    (accumulator, line) => {
      const separatorIndex = line.indexOf(':');

      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();

      if (key && value) {
        accumulator[key] = value;
      }

      return accumulator;
    },
    {}
  );

  return {
    attributes,
    body: body.trim()
  };
}

interface ParsedSkillFile {
  skill: SkillDefinition;
  originPath: string;
}

function readSkillsFromDirectory(
  directoryPath: string,
  source: SkillDefinition['source'],
  logger?: Logger
): ParsedSkillFile[] {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.md') &&
        entry.name.toLowerCase() !== 'readme.md'
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filePath = path.join(directoryPath, entry.name);

      try {
        const contents = readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(contents);
        const fallbackId = path.basename(entry.name, '.md');

        return [
          {
            originPath: filePath,
            skill: skillDefinitionSchema.parse({
              id: parsed.attributes.id ?? fallbackId,
              title: parsed.attributes.title ?? fallbackId,
              description: parsed.attributes.description ?? 'Skill prompt',
              prompt: parsed.body,
              source,
              readOnly: source === 'builtin'
            })
          }
        ];
      } catch (error) {
        logger?.warn(
          {
            filePath,
            source,
            error: error instanceof Error ? error.message : String(error)
          },
          'Skipping invalid skill file'
        );

        return [];
      }
    });
}

export class SkillRegistry {
  private readonly repository: SkillRepository;
  private loaded = false;

  constructor(
    private readonly baseDirectory: string,
    database: DatabaseManager,
    private readonly logger?: Logger
  ) {
    this.repository = new SkillRepository(database);
  }

  load(force = false): void {
    if (this.loaded && !force) {
      return;
    }

    const builtinSkills = readSkillsFromDirectory(
      path.join(this.baseDirectory, 'builtin'),
      'builtin',
      this.logger
    );
    const legacyUserSkills = readSkillsFromDirectory(
      path.join(this.baseDirectory, 'user'),
      'user',
      this.logger
    );

    this.repository.replaceBuiltinSkills(
      builtinSkills.map((entry) => ({
        ...entry.skill,
        originPath: entry.originPath
      }))
    );
    this.repository.importUserSkills(
      legacyUserSkills.map((entry) => ({
        ...entry.skill,
        originPath: entry.originPath
      }))
    );

    this.loaded = true;
  }

  refresh(): void {
    this.load(true);
  }

  list(): SkillDefinition[] {
    this.ensureLoaded();
    return this.repository.list();
  }

  getById(skillId: string): SkillDefinition | null {
    this.ensureLoaded();
    return this.repository.getById(skillId);
  }

  createSkill(input: CreateSkillInput): SkillDefinition {
    this.ensureLoaded();
    return this.repository.createUserSkill(input);
  }

  updateSkill(input: UpdateSkillInput): SkillDefinition {
    this.ensureLoaded();
    return this.repository.updateUserSkill(input);
  }

  deleteSkill(skillId: string): void {
    this.ensureLoaded();
    this.repository.deleteUserSkill(skillId);
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load(true);
    }
  }
}

export function listBuiltinSkills(baseDirectory?: string): SkillDefinition[] {
  if (!baseDirectory) {
    return [];
  }

  return readSkillsFromDirectory(path.join(baseDirectory, 'builtin'), 'builtin').map(
    (entry) => entry.skill
  );
}

export { SkillRepository } from './repository';
