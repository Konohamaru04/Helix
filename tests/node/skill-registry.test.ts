import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { SkillRegistry } from '@bridge/skills';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-skill-registry-'));
  const builtinDirectory = path.join(directory, 'builtin');
  const userDirectory = path.join(directory, 'user');
  const logger = createLogger('skill-registry-test');
  const database = new DatabaseManager(path.join(directory, 'ollama-desktop.sqlite'), logger);

  mkdirSync(builtinDirectory, { recursive: true });
  mkdirSync(userDirectory, { recursive: true });
  database.initialize();
  tempDirectories.push(directory);

  return {
    directory,
    builtinDirectory,
    userDirectory,
    database
  };
}

describe('SkillRegistry', () => {
  it('seeds builtin skills into SQLite and imports legacy user files once', () => {
    const harness = createHarness();

    try {
      writeFileSync(
        path.join(harness.builtinDirectory, 'builder.md'),
        `---
id: builder
title: Builder
description: Builtin builder skill
---
Use the builtin builder flow.
`,
        'utf8'
      );

      writeFileSync(
        path.join(harness.userDirectory, 'legacy.md'),
        `---
id: legacy-skill
title: Legacy Skill
description: Imported from disk
---
Legacy prompt body.
`,
        'utf8'
      );

      const registry = new SkillRegistry(
        harness.directory,
        harness.database,
        createLogger('skill-registry-seed-test')
      );
      registry.load();

      expect(registry.getById('builder')?.source).toBe('builtin');
      expect(registry.getById('builder')?.readOnly).toBe(true);
      expect(registry.getById('legacy-skill')?.source).toBe('user');

      writeFileSync(
        path.join(harness.userDirectory, 'legacy.md'),
        `---
id: legacy-skill
title: Legacy Skill Updated
description: Should not override SQLite
---
Updated legacy prompt body.
`,
        'utf8'
      );

      registry.load(true);

      expect(registry.getById('legacy-skill')?.title).toBe('Legacy Skill');
      expect(registry.getById('legacy-skill')?.prompt).toContain('Legacy prompt body');
    } finally {
      harness.database.close();
    }
  });

  it('creates, updates, and deletes user skills in SQLite', () => {
    const harness = createHarness();

    try {
      const registry = new SkillRegistry(
        harness.directory,
        harness.database,
        createLogger('skill-registry-crud-test')
      );
      registry.load();

      const created = registry.createSkill({
        title: 'Custom Reviewer',
        description: 'Review code with strict risk focus.',
        prompt: 'Act like a rigorous code reviewer.'
      });

      expect(created.source).toBe('user');
      expect(created.id).toBe('custom-reviewer');
      expect(registry.getById('custom-reviewer')?.title).toBe('Custom Reviewer');

      const duplicateTitle = registry.createSkill({
        title: 'Custom Reviewer',
        description: 'A second skill with the same title.',
        prompt: 'Act like another reviewer.'
      });

      expect(duplicateTitle.id).toBe('custom-reviewer-2');
      expect(registry.getById('custom-reviewer-2')?.title).toBe('Custom Reviewer');

      const updated = registry.updateSkill({
        skillId: 'custom-reviewer',
        title: 'Custom Reviewer V2',
        description: 'Review code with stronger failure analysis.',
        prompt: 'Act like a rigorous code reviewer and focus on regressions.'
      });

      expect(updated.id).toBe('custom-reviewer');
      expect(registry.getById('custom-reviewer')?.title).toBe('Custom Reviewer V2');

      registry.deleteSkill('custom-reviewer');

      expect(registry.getById('custom-reviewer')).toBeNull();
    } finally {
      harness.database.close();
    }
  });

  it('skips invalid skill files without breaking the registry', () => {
    const harness = createHarness();

    try {
      writeFileSync(
        path.join(harness.builtinDirectory, 'grounded.md'),
        `---
id: grounded
title: Grounded
description: Builtin grounded skill
---
Ground answers in cited evidence.
`,
        'utf8'
      );

      writeFileSync(
        path.join(harness.userDirectory, 'broken.md'),
        `---
id: broken
title: Broken
description: Missing prompt body
---
`,
        'utf8'
      );

      const registry = new SkillRegistry(
        harness.directory,
        harness.database,
        createLogger('skill-registry-invalid-test')
      );

      expect(() => registry.load()).not.toThrow();
      expect(registry.getById('grounded')?.title).toBe('Grounded');
      expect(registry.getById('broken')).toBeNull();
      expect(registry.list()).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });
});
