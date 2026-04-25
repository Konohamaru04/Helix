import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { CapabilityRepository, CapabilityService } from '@bridge/capabilities';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { defaultUserSettings } from '@bridge/settings/service';
import { SkillRegistry } from '@bridge/skills';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-capabilities-'));
  tempDirectories.push(directory);
  const logger = createLogger('capability-service-test');
  const database = new DatabaseManager(path.join(directory, 'ollama-desktop.sqlite'), logger);
  database.initialize();

  const chatRepository = new ChatRepository(database);
  chatRepository.ensureDefaultWorkspace();
  const capabilityRepository = new CapabilityRepository(database);
  const skillRegistry = new SkillRegistry(path.join('E:\\OllamaDesktop', 'skills'), database);
  skillRegistry.load();
  const ollamaClient = {
    getStatus: vi.fn().mockResolvedValue({
      reachable: true,
      baseUrl: defaultUserSettings.ollamaBaseUrl,
      checkedAt: '2026-04-11T00:00:00.000Z',
      error: null,
      models: [{ name: 'llama3.2:latest', size: null, digest: null }]
    }),
    completeChat: vi.fn().mockResolvedValue({
      content: 'Internal agent reply.',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    })
  };
  const nvidiaClient = {
    getStatus: vi.fn().mockResolvedValue({
      configured: true,
      baseUrl: defaultUserSettings.nvidiaBaseUrl,
      checkedAt: '2026-04-13T00:00:00.000Z',
      error: null,
      models: [{ name: 'meta/llama-3.1-8b-instruct', size: null, digest: null }]
    }),
    completeChat: vi.fn().mockResolvedValue({
      content: 'Internal agent reply.',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    })
  };
  const service = new CapabilityService(
    directory,
    capabilityRepository,
    chatRepository,
    skillRegistry,
    {
      get: () => defaultUserSettings
    },
    ollamaClient as never,
    nvidiaClient as never,
    logger
  );

  return {
    directory,
    database,
    capabilityRepository,
    service
  };
}

describe('CapabilityService', () => {
  it('enforces permission grants for write-capable tools and records the write after approval', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.service.executeTool({
          toolId: 'write',
          prompt: JSON.stringify({
            filePath: 'notes/todo.txt',
            content: 'ship milestone 4.1'
          }),
          workspaceRootPath: harness.directory
        })
      ).rejects.toThrow('requires approval');

      harness.service.grantPermission({
        capabilityId: 'write',
        scopeKind: 'global',
        scopeId: null
      });

      const result = await harness.service.executeTool({
        toolId: 'write',
        prompt: JSON.stringify({
          filePath: 'notes/todo.txt',
          content: 'ship milestone 4.1'
        }),
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(readFileSync(path.join(harness.directory, 'notes', 'todo.txt'), 'utf8')).toBe(
        'ship milestone 4.1'
      );
      expect(
        harness.service.listAuditEvents().some((event) => event.action === 'write:completed')
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it('accepts path aliases for write and edit capability inputs', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'write',
        scopeKind: 'global',
        scopeId: null
      });
      harness.service.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'global',
        scopeId: null
      });

      await harness.service.executeTool({
        toolId: 'write',
        prompt: JSON.stringify({
          path: 'notes/aliases.txt',
          content: 'hello world'
        }),
        workspaceRootPath: harness.directory
      });

      await harness.service.executeTool({
        toolId: 'edit',
        prompt: JSON.stringify({
          path: 'notes/aliases.txt',
          search: 'world',
          replacement: 'forge',
          replace_all: true
        }),
        workspaceRootPath: harness.directory
      });

      expect(
        readFileSync(path.join(harness.directory, 'notes', 'aliases.txt'), 'utf8')
      ).toBe('hello forge');
    } finally {
      harness.database.close();
    }
  });

  it('recovers write inputs from malformed JSON-like payloads with raw newlines and Windows paths', async () => {
    const harness = createHarness();

    try {
      const windowsProjectsPath = 'C:\\Users\\<User>\\AppData\\Roaming\\Screenwriter\\projects\\';

      harness.service.grantPermission({
        capabilityId: 'write',
        scopeKind: 'global',
        scopeId: null
      });

      const malformedPrompt = `{"filePath":"notes/screenwriter_summary.md","content":"# Screenwriter Summary

## Overview

- Windows data dir: ${windowsProjectsPath}
- Status indicator: "Unsaved changes" / "Saved"
"}`;

      const result = await harness.service.executeTool({
        toolId: 'write',
        prompt: malformedPrompt,
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(
        readFileSync(path.join(harness.directory, 'notes', 'screenwriter_summary.md'), 'utf8')
      ).toBe(`# Screenwriter Summary

## Overview

- Windows data dir: ${windowsProjectsPath}
- Status indicator: "Unsaved changes" / "Saved"
`);
    } finally {
      harness.database.close();
    }
  });

  it('accepts write payloads whose content contains embedded fenced code blocks', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'write',
        scopeKind: 'global',
        scopeId: null
      });

      const prompt = JSON.stringify({
        filePath: 'notes/screenwriter_summary.md',
        content: [
          '# Screenwriter Summary',
          '',
          '## Project Structure',
          '',
          '```text',
          'Screenwriter/',
          '+-- src/',
          '+-- package.json',
          '```',
          '',
          '## Screenplay File Format',
          '',
          '```json',
          '{',
          '  "meta": {',
          '    "app": "electron-screenplay-writer"',
          '  }',
          '}',
          '```',
          ''
        ].join('\n')
      });

      const result = await harness.service.executeTool({
        toolId: 'write',
        prompt,
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(
        readFileSync(path.join(harness.directory, 'notes', 'screenwriter_summary.md'), 'utf8')
      ).toContain('```json');
      expect(
        readFileSync(path.join(harness.directory, 'notes', 'screenwriter_summary.md'), 'utf8')
      ).toContain('"electron-screenplay-writer"');
    } finally {
      harness.database.close();
    }
  });

  it('extracts filenames from natural-language read prompts', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const readableFile = path.join(workspaceRoot, 'screenwriter_summary.md');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(readableFile, '# Screenwriter Summary\n\nFixed unicode symbols.\n', 'utf8');

      const result = await harness.service.executeTool({
        toolId: 'read',
        prompt:
          'in "screenwriter_summary.md" file fix the symbols it has questionmarks everywhere probably some missing unicode characters.',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe(readableFile);
      expect(result.assistantContent).toContain('Fixed unicode symbols.');
      expect(result.contextSources[0]?.sourcePath).toBe(readableFile);
    } finally {
      harness.database.close();
    }
  });

  it('reads direct file paths that contain spaces', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const readableFile = path.join(workspaceRoot, 'IMG to VIDEO 2.4 BASE SIMPLE.json');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(readableFile, '{"workflow": "wan"}\n', 'utf8');

      const relativeResult = await harness.service.executeTool({
        toolId: 'read',
        prompt: 'IMG to VIDEO 2.4 BASE SIMPLE.json',
        workspaceRootPath: workspaceRoot
      });

      expect(relativeResult.toolInvocations[0]?.status).toBe('completed');
      expect(relativeResult.toolInvocations[0]?.inputSummary).toBe(readableFile);
      expect(relativeResult.assistantContent).toContain('"workflow": "wan"');

      const absoluteResult = await harness.service.executeTool({
        toolId: 'read',
        prompt: readableFile,
        workspaceRootPath: workspaceRoot
      });

      expect(absoluteResult.toolInvocations[0]?.status).toBe('completed');
      expect(absoluteResult.toolInvocations[0]?.inputSummary).toBe(readableFile);
      expect(absoluteResult.assistantContent).toContain('"workflow": "wan"');
    } finally {
      harness.database.close();
    }
  });

  it('matches workspace files from keyed glob patterns', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'workflows', 'nested'), { recursive: true });
      mkdirSync(path.join(workspaceRoot, 'dist'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'workflows', 'workflow.json'), '{}\n', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'workflows', 'nested', 'config.json'), '{}\n', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'workflows', 'notes.txt'), 'notes\n', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'dist', 'ignored.json'), '{}\n', 'utf8');

      const result = await harness.service.executeTool({
        toolId: 'glob',
        prompt: 'pattern: "**/*.json"',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.outputSummary).toBe('2 match(es)');
      expect(result.assistantContent).toContain('workflows/workflow.json');
      expect(result.assistantContent).toContain('workflows/nested/config.json');
      expect(result.assistantContent).not.toContain('workflows/notes.txt');
      expect(result.assistantContent).not.toContain('dist/ignored.json');
    } finally {
      harness.database.close();
    }
  });

  it('treats non-zero shell exits as completed command results when the process finishes normally', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'powershell',
        scopeKind: 'global',
        scopeId: null
      });

      const result = await harness.service.executeTool({
        toolId: 'powershell',
        prompt: "[Console]::Out.WriteLine('stdout line'); [Console]::Error.WriteLine('stderr line'); exit 1",
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.errorMessage).toBeNull();
      expect(result.assistantContent).toContain('stdout line');
      expect(result.assistantContent).toContain('stderr line');
      expect(result.assistantContent).toContain('Exit code: 1');
    } finally {
      harness.database.close();
    }
  });

  it('accepts oldText/newText edit aliases and tolerates newline-style differences', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'global',
        scopeId: null
      });

      const targetDirectory = path.join(harness.directory, 'notes');
      const targetPath = path.join(targetDirectory, 'windows-lines.txt');
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(
        targetPath,
        ['from app import models, schemas, crud', '', "__all__ = ['models', 'schemas', 'crud']"].join(
          '\r\n'
        ),
        'utf8'
      );

      const result = await harness.service.executeTool({
        toolId: 'edit',
        prompt: JSON.stringify({
          path: 'notes/windows-lines.txt',
          oldText: "from app import models, schemas, crud\n\n__all__ = ['models', 'schemas', 'crud']",
          newText:
            "from app import models, schemas, crud, app\nfrom app.database import get_db\n\n__all__ = ['models', 'schemas', 'crud', 'get_db', 'app']"
        }),
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(readFileSync(targetPath, 'utf8')).toContain(
        "from app.database import get_db\r\n\r\n__all__ = ['models', 'schemas', 'crud', 'get_db', 'app']"
      );
    } finally {
      harness.database.close();
    }
  });

  it('recovers edit inputs from malformed JSON-like payloads with raw newlines and Windows paths', async () => {
    const harness = createHarness();

    try {
      const windowsProjectsPath = 'C:\\Users\\<User>\\AppData\\Roaming\\Screenwriter\\projects\\';

      harness.service.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'global',
        scopeId: null
      });

      const targetDirectory = path.join(harness.directory, 'notes');
      const targetPath = path.join(targetDirectory, 'encoding-fix.md');
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(
        targetPath,
        `Start
Path: placeholder
End
`,
        'utf8'
      );

      const malformedPrompt = `{"filePath":"notes/encoding-fix.md","search":"Path: placeholder","replacement":"Path: ${windowsProjectsPath}
Status: "Saved"","replaceAll":true}`;

      const result = await harness.service.executeTool({
        toolId: 'edit',
        prompt: malformedPrompt,
        workspaceRootPath: harness.directory
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(readFileSync(targetPath, 'utf8')).toBe(`Start
Path: ${windowsProjectsPath}
Status: "Saved"
End
`);
    } finally {
      harness.database.close();
    }
  });

  it('creates and retrieves tracked tasks from JSON tool input', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });

      const createResult = await harness.service.executeTool({
        toolId: 'task-create',
        prompt: JSON.stringify({
          title: 'Implement tool permissions',
          details: 'Wire the capability permissions UI and preload bridge.'
        })
      });

      const createdTaskId = createResult.toolInvocations[0]?.outputSummary;
      expect(createdTaskId).toBeTruthy();
      expect(harness.service.listTasks(null)).toHaveLength(1);

      const lookupResult = await harness.service.executeTool({
        toolId: 'task-get',
        prompt: JSON.stringify({
          taskId: createdTaskId
        })
      });

      expect(lookupResult.assistantContent).toContain('Implement tool permissions');
      expect(lookupResult.assistantContent).toContain('pending');
    } finally {
      harness.database.close();
    }
  });

  it('searches tools, tasks, schedules, and resources through tool-search', async () => {
    const harness = createHarness();

    try {
      harness.service.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });
      harness.service.grantPermission({
        capabilityId: 'cron-create',
        scopeKind: 'global',
        scopeId: null
      });

      await harness.service.executeTool({
        toolId: 'task-create',
        prompt: JSON.stringify({
          title: 'General audit task',
          details: 'Verify the broader tool surface.'
        })
      });
      await harness.service.executeTool({
        toolId: 'cron-create',
        prompt: JSON.stringify({
          title: 'General audit schedule',
          prompt: 'Review audit events',
          kind: 'interval',
          intervalSeconds: 3600
        })
      });

      const result = await harness.service.executeTool({
        toolId: 'tool-search',
        prompt: 'general'
      });

      expect(result.assistantContent).toContain('Task: General audit task');
      expect(result.assistantContent).toContain('Schedule: General audit schedule');
      expect(result.contextSources.some((source) => source.label.startsWith('Workspace:'))).toBe(true);
    } finally {
      harness.database.close();
    }
  });
});
