import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillDefinition } from '@bridge/ipc/contracts';
import { skillDefinitionSchema } from '@bridge/ipc/contracts';

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

function readSkillsFromDirectory(directoryPath: string, source: SkillDefinition['source']) {
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
    .map((entry) => {
      const filePath = path.join(directoryPath, entry.name);
      const contents = readFileSync(filePath, 'utf8');
      const parsed = parseFrontmatter(contents);
      const fallbackId = path.basename(entry.name, '.md');

      return skillDefinitionSchema.parse({
        id: parsed.attributes.id ?? fallbackId,
        title: parsed.attributes.title ?? fallbackId,
        description: parsed.attributes.description ?? 'Skill prompt',
        prompt: parsed.body,
        source
      });
    });
}

export class SkillRegistry {
  private skills: SkillDefinition[] = [];

  constructor(private readonly baseDirectory: string) {}

  load(): void {
    const builtinDirectory = path.join(this.baseDirectory, 'builtin');
    const userDirectory = path.join(this.baseDirectory, 'user');

    this.skills = [
      ...readSkillsFromDirectory(builtinDirectory, 'builtin'),
      ...readSkillsFromDirectory(userDirectory, 'user')
    ].sort((left, right) => left.title.localeCompare(right.title));
  }

  list(): SkillDefinition[] {
    return [...this.skills];
  }

  getById(skillId: string): SkillDefinition | null {
    return this.skills.find((skill) => skill.id === skillId) ?? null;
  }
}

export function listBuiltinSkills(baseDirectory?: string): SkillDefinition[] {
  if (!baseDirectory) {
    return [];
  }

  return readSkillsFromDirectory(path.join(baseDirectory, 'builtin'), 'builtin');
}
