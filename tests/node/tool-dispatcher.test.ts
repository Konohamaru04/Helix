import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { DatabaseManager } from '@bridge/db/database';
import { createLogger } from '@bridge/logging/logger';
import { RagService } from '@bridge/rag';
import {
  type WebSearcher,
  type WorkspacePathLauncher,
  ToolDispatcher
} from '@bridge/tools';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(options?: {
  openWorkspacePath?: WorkspacePathLauncher;
  webSearcher?: WebSearcher;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-tools-'));
  tempDirectories.push(directory);
  const logger = createLogger('tool-dispatcher-test');
  const database = new DatabaseManager(path.join(directory, 'ollama-desktop.sqlite'), logger);
  database.initialize();

  const repository = new ChatRepository(database);
  repository.ensureDefaultWorkspace();
  const ragService = new RagService(database, logger);
  const dispatcher = new ToolDispatcher(
    directory,
    repository,
    ragService,
    options?.openWorkspacePath,
    options?.webSearcher
  );

  return { directory, database, repository, ragService, dispatcher };
}

describe('ToolDispatcher', () => {
  it('runs dependency-free JavaScript snippets in the safe code runner', async () => {
    const harness = createHarness();

    try {
      const result = await harness.dispatcher.execute({
        toolId: 'code-runner',
        prompt: '```js\nconst value = 2 + 4;\nconsole.log(value);\nreturn value * 2;\n```'
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.toolId).toBe('code-runner');
      expect(result.assistantContent).toContain('Stdout');
      expect(result.assistantContent).toContain('6');
      expect(result.assistantContent).toContain('12');
    } finally {
      harness.database.close();
    }
  });

  it('blocks host access in the code runner sandbox', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.dispatcher.execute({
          toolId: 'code-runner',
          prompt: '```js\nrequire("node:fs")\n```'
        })
      ).rejects.toThrow('blocks imports');
    } finally {
      harness.database.close();
    }
  });

  it('extracts arithmetic expressions from natural language prompts', async () => {
    const harness = createHarness();

    try {
      const result = await harness.dispatcher.execute({
        toolId: 'calculator',
        prompt: 'What is 2 + 4?'
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('2 + 4');
      expect(result.toolInvocations[0]?.outputSummary).toBe('6');
      expect(result.assistantContent).toContain('**6**');
    } finally {
      harness.database.close();
    }
  });

  it('handles calculator prompts that include a follow-up explanation request', async () => {
    const harness = createHarness();

    try {
      const result = await harness.dispatcher.execute({
        toolId: 'calculator',
        prompt: 'calculate 2 + 2 and explain the result'
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('2 + 2');
      expect(result.toolInvocations[0]?.outputSummary).toBe('4');
    } finally {
      harness.database.close();
    }
  });

  it('rejects unsafe calculator expressions', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.dispatcher.execute({
          toolId: 'calculator',
          prompt: '2 + process.exit(1)'
        })
      ).rejects.toThrow('calculator only accepts');
    } finally {
      harness.database.close();
    }
  });

  it('reads safe workspace files and emits source provenance', async () => {
    const harness = createHarness();

    try {
      const readableFile = path.join(harness.directory, 'notes.txt');
      writeFileSync(readableFile, 'hello from workspace', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'file-reader',
        prompt: readableFile
      });

      expect(result.assistantContent).toContain('hello from workspace');
      expect(result.toolInvocations[0]?.toolId).toBe('file-reader');
      expect(result.toolInvocations[0]?.outputText).toContain('hello from workspace');
      expect(result.contextSources[0]?.sourcePath).toBe(readableFile);
      expect(result.contextSources[0]?.excerpt).toContain('hello from workspace');
    } finally {
      harness.database.close();
    }
  });

  it('blocks file reads outside allowed paths', async () => {
    const harness = createHarness();

    try {
      const forbiddenPath = path.join(tmpdir(), 'outside-reader-test.txt');
      writeFileSync(forbiddenPath, 'forbidden', 'utf8');

      await expect(
        harness.dispatcher.execute({
          toolId: 'file-reader',
          prompt: forbiddenPath
        })
      ).rejects.toThrow('can only access files');
    } finally {
      harness.database.close();
    }
  });

  it('reads relative paths from the connected workspace root', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const nestedDirectory = path.join(workspaceRoot, 'src');
      const readableFile = path.join(nestedDirectory, 'index.ts');
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(readableFile, 'export const ready = true;', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'file-reader',
        prompt: 'src/index.ts',
        workspaceRootPath: workspaceRoot
      });

      expect(result.assistantContent).toContain('export const ready = true;');
      expect(result.contextSources[0]?.sourcePath).toBe(readableFile);
    } finally {
      harness.database.close();
    }
  });

  it('extracts filenames from natural-language file-reader prompts', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const readableFile = path.join(workspaceRoot, 'screenwriter_summary.md');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(readableFile, '# Screenwriter Summary\n\nFixed symbols.\n', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'file-reader',
        prompt: 'try again and file name is screenwriter_summary.md',
        workspaceRootPath: workspaceRoot
      });

      expect(result.assistantContent).toContain('Fixed symbols.');
      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe(readableFile);
      expect(result.contextSources[0]?.sourcePath).toBe(readableFile);
    } finally {
      harness.database.close();
    }
  });

  it('lists directories from the connected workspace root', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'README.md'), '# hello', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: '',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.toolId).toBe('workspace-lister');
      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.assistantContent).toContain('src/');
      expect(result.assistantContent).toContain('README.md');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('treats natural-language current-directory prompts as the workspace root', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'clips'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'README.md'), '# hello', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: 'List all the files in this directory',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('.');
      expect(result.assistantContent).toContain('clips/');
      expect(result.assistantContent).toContain('README.md');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('treats typo variants like "in this directlry" as the workspace root', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'raw-footage'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'Readme.txt'), 'hello', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: 'List out all the files in this directlry',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('.');
      expect(result.assistantContent).toContain('raw-footage/');
      expect(result.assistantContent).toContain('Readme.txt');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('extracts explicit corrective directory paths from follow-up prompts', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'clips'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'Readme.txt'), 'hello', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: `${workspaceRoot} is the correct directory`,
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('.');
      expect(result.assistantContent).toContain('clips/');
      expect(result.assistantContent).toContain('Readme.txt');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('extracts nested directory targets from natural-language workspace list prompts', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const nestedDirectory = path.join(workspaceRoot, 'src', 'components');
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(path.join(nestedDirectory, 'Button.tsx'), 'export function Button() {}', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: 'Show me the files in src/components',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe(path.join('src', 'components'));
      expect(result.assistantContent).toContain('Button.tsx');
      expect(result.contextSources[0]?.sourcePath).toBe(nestedDirectory);
    } finally {
      harness.database.close();
    }
  });

  it('falls back to the workspace root when a natural-language follow-up reaches the lister', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'clips'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'Readme.txt'), 'hello', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt: "I don't see the updated files",
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('.');
      expect(result.assistantContent).toContain('clips/');
      expect(result.assistantContent).toContain('Readme.txt');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('treats repository-summary prompts as requests for the connected workspace root', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'README.md'), '# Screenwriter', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-lister',
        prompt:
          'Analyze this repository and and create a summary of the implementation in a markup file (For LLM understanding)',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.inputSummary).toBe('.');
      expect(result.assistantContent).toContain('src/');
      expect(result.assistantContent).toContain('README.md');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('opens safe workspace media files with the system launcher', async () => {
    const openWorkspacePath = vi
      .fn<WorkspacePathLauncher>()
      .mockResolvedValue('');
    const harness = createHarness({ openWorkspacePath });

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const videoPath = path.join(workspaceRoot, 'TWICE_Hare_Hare_Music_Video.mp4');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(videoPath, 'video', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-opener',
        prompt: 'play TWICE_Hare_Hare_Music_Video.mp4',
        workspaceRootPath: workspaceRoot
      });

      expect(openWorkspacePath).toHaveBeenCalledWith(videoPath);
      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.toolInvocations[0]?.toolId).toBe('workspace-opener');
      expect(result.toolInvocations[0]?.inputSummary).toBe('TWICE_Hare_Hare_Music_Video.mp4');
      expect(result.assistantContent).toContain('Opened file');
    } finally {
      harness.database.close();
    }
  });

  it('blocks opening executable workspace files for safety', async () => {
    const openWorkspacePath = vi
      .fn<WorkspacePathLauncher>()
      .mockResolvedValue('');
    const harness = createHarness({ openWorkspacePath });

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const executablePath = path.join(workspaceRoot, 'dangerous.exe');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(executablePath, 'binary', 'utf8');

      await expect(
        harness.dispatcher.execute({
          toolId: 'workspace-opener',
          prompt: 'open dangerous.exe',
          workspaceRootPath: workspaceRoot
        })
      ).rejects.toThrow('blocked for safety');

      expect(openWorkspacePath).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('searches workspace file contents and filenames safely', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      const authDirectory = path.join(workspaceRoot, 'src', 'auth');
      mkdirSync(authDirectory, { recursive: true });
      writeFileSync(
        path.join(authDirectory, 'AuthProvider.tsx'),
        'export function AuthProvider() { return "auth-ready"; }',
        'utf8'
      );

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-search',
        prompt: 'AuthProvider',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.toolId).toBe('workspace-search');
      expect(result.toolInvocations[0]?.outputSummary).toContain('match');
      expect(result.contextSources[0]?.label).toContain('AuthProvider.tsx');
      expect(result.contextSources[0]?.excerpt).toContain('AuthProvider');
    } finally {
      harness.database.close();
    }
  });

  it('returns a workspace root snapshot when search has no direct matches', async () => {
    const harness = createHarness();

    try {
      const workspaceRoot = path.join(harness.directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<!doctype html>', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'styles.css'), 'body { color: black; }', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'script.js'), 'console.log("ready");', 'utf8');

      const result = await harness.dispatcher.execute({
        toolId: 'workspace-search',
        prompt: 'In existing code implement sign-up feature as well.',
        workspaceRootPath: workspaceRoot
      });

      expect(result.toolInvocations[0]?.toolId).toBe('workspace-search');
      expect(result.toolInvocations[0]?.outputSummary).toBe(
        'No direct matches; workspace root has 3 item(s).'
      );
      expect(result.assistantContent).toContain('Top-level workspace items (3 total):');
      expect(result.assistantContent).toContain('index.html');
      expect(result.contextSources[0]?.label).toBe('workspace-root');
      expect(result.contextSources[0]?.sourcePath).toBe(workspaceRoot);
    } finally {
      harness.database.close();
    }
  });

  it('searches imported workspace knowledge with grounded sources', async () => {
    const harness = createHarness();

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const documents = harness.ragService.importAttachments(workspace.id, [
        {
          id: '80000000-0000-4000-8000-000000000001',
          fileName: 'guide.md',
          filePath: null,
          mimeType: 'text/markdown',
          sizeBytes: 64,
          extractedText: 'Authentication uses short-lived access tokens and refresh tokens.',
          createdAt: '2026-04-08T00:00:00.000Z'
        }
      ]);

      expect(documents.documents).toHaveLength(1);

      const result = await harness.dispatcher.execute({
        toolId: 'knowledge-search',
        prompt: 'authentication tokens',
        workspaceId: workspace.id
      });

      expect(result.toolInvocations[0]?.toolId).toBe('knowledge-search');
      expect(result.toolInvocations[0]?.status).toBe('completed');
      expect(result.assistantContent).toContain('Knowledge Search');
      expect(result.contextSources[0]?.label).toBe('guide.md');
      expect(result.contextSources[0]?.excerpt).toContain('tokens');
    } finally {
      harness.database.close();
    }
  });

  it('returns source-linked web search snippets', async () => {
    const webSearcher = vi.fn<WebSearcher>().mockResolvedValue([
      {
        title: 'Electron Releases',
        url: 'https://releases.electronjs.org/releases/stable',
        snippet: 'All historical Electron releases.'
      },
      {
        title: 'electron/electron releases',
        url: 'https://github.com/electron/electron/releases',
        snippet: 'Release notes for Electron on GitHub.'
      }
    ]);
    const harness = createHarness({ webSearcher });

    try {
      const result = await harness.dispatcher.execute({
        toolId: 'web-search',
        prompt: 'search the web for latest electron release notes'
      });

      expect(webSearcher).toHaveBeenCalledWith(
        'latest electron release notes',
        5
      );
      expect(result.toolInvocations[0]?.toolId).toBe('web-search');
      expect(result.contextSources).toHaveLength(2);
      expect(result.contextSources[0]?.sourcePath).toBe(
        'https://releases.electronjs.org/releases/stable'
      );
      expect(result.assistantContent).toContain('Web Search');
      expect(result.assistantContent).toContain('Electron Releases');
    } finally {
      harness.database.close();
    }
  });

  it('rejects relative paths when no workspace folder is connected', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.dispatcher.execute({
          toolId: 'file-reader',
          prompt: 'src/index.ts'
        })
      ).rejects.toThrow('Connect a workspace folder');
    } finally {
      harness.database.close();
    }
  });
});
