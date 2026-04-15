import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_USER_AGENT, APP_WORKTREE_DIRECTORY_NAME } from '@bridge/branding';
import { isBinaryExtension } from '@bridge/tools';
import type { ChatRepository } from '@bridge/chat/repository';
import {
  type AgentSession,
  type AuditEventRecord,
  type CapabilityPermission,
  type CapabilityPermissionInput,
  type CapabilityTask,
  type ContextSource,
  type PlanState,
  type ScheduledPrompt,
  type TeamSession,
  type ToolDefinition,
  type ToolInvocation,
  type UserSettings,
  type WorktreeSession,
  contextSourceSchema,
  toolDefinitionSchema,
  toolInvocationSchema
} from '@bridge/ipc/contracts';
import { parseJsonishRecord } from '@bridge/jsonish';
import type { NvidiaClient } from '@bridge/nvidia/client';
import type { OllamaClient } from '@bridge/ollama/client';
import { extractPromptPathCandidate } from '@bridge/path-prompt';
import { SkillRegistry } from '@bridge/skills';
import type { Logger } from 'pino';
import { CapabilityRepository } from './repository';

const TEXT_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.ipynb'
]);
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.turbo',
  '.vite',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
  'temp'
]);
const MAX_FILE_BYTES = 512_000;
const MAX_FILE_CHARACTERS = 24_000;
const MAX_PROCESS_OUTPUT = 12_000;
const PROCESS_TIMEOUT_MS = 20_000;

const capabilityDefinitions = [
  {
    id: 'agent',
    title: 'Agent',
    description: 'Run a sub-agent style background reasoning session with isolated message history.',
    command: '/agent',
    kind: 'agent',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'ask-user-question',
    title: 'Ask User Question',
    description: 'Render a structured multiple-choice clarification prompt inside the transcript.',
    command: '/ask',
    kind: 'tool',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  // {
  //   id: 'bash',
  //   title: 'Bash',
  //   description: 'Execute a bash command with bounded runtime and captured output.',
  //   command: '/bash',
  //   kind: 'tool',
  //   permissionClass: 'always_confirm',
  //   availability: 'available',
  //   autoRoutable: false
  // },
  {
    id: 'cron-create',
    title: 'Cron Create',
    description: 'Create a scheduled prompt with one-shot or interval timing.',
    command: '/cron-create',
    kind: 'schedule',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'cron-delete',
    title: 'Cron Delete',
    description: 'Delete a scheduled prompt by id.',
    command: '/cron-delete',
    kind: 'schedule',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'cron-list',
    title: 'Cron List',
    description: 'List session schedules and next run times.',
    command: '/cron-list',
    kind: 'schedule',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'edit',
    title: 'Edit',
    description:
      'Apply a targeted search-and-replace edit inside an allowed local file. Prefer JSON with filePath or path, search or oldText, and replace, replacement, or newText. The search text must match the current file exactly, including whitespace and line breaks.',
    command: '/edit',
    kind: 'tool',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'enter-plan-mode',
    title: 'Enter Plan Mode',
    description: 'Switch the current conversation into plan mode for structured planning.',
    command: '/plan-on',
    kind: 'mode',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'enter-worktree',
    title: 'Enter Worktree',
    description: 'Create and enter a git worktree for an isolated branch.',
    command: '/worktree-enter',
    kind: 'workspace',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'exit-plan-mode',
    title: 'Exit Plan Mode',
    description: 'Exit plan mode and persist the latest plan summary.',
    command: '/plan-off',
    kind: 'mode',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'exit-worktree',
    title: 'Exit Worktree',
    description: 'Close a tracked git worktree session and remove the worktree path.',
    command: '/worktree-exit',
    kind: 'workspace',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'glob',
    title: 'Glob',
    description: 'Find files by glob pattern inside the connected workspace.',
    command: '/glob',
    kind: 'tool',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: true
  },
  {
    id: 'grep',
    title: 'Grep',
    description: 'Search file contents by plain-text query inside the connected workspace.',
    command: '/grep-files',
    kind: 'tool',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: true
  },
  {
    id: 'list-mcp-resources',
    title: 'List MCP Resources',
    description: 'List resources exposed by the local MCP bridge.',
    command: '/mcp-list',
    kind: 'mcp',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'lsp',
    title: 'LSP',
    description: 'Run lightweight code-intelligence lookups for definitions, references, and diagnostics.',
    command: '/lsp',
    kind: 'lsp',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'monitor',
    title: 'Monitor',
    description: 'Run a background command and stream its output into a tracked task.',
    command: '/monitor',
    kind: 'tool',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  },
  // {
  //   id: 'notebook-edit',
  //   title: 'Notebook Edit',
  //   description: 'Replace a Jupyter notebook cell source by index.',
  //   command: '/notebook-edit',
  //   kind: 'tool',
  //   permissionClass: 'always_confirm',
  //   availability: 'available',
  //   autoRoutable: false
  // },
  {
    id: 'powershell',
    title: 'PowerShell',
    description: 'Execute a PowerShell command with bounded runtime and captured output.',
    command: '/powershell',
    kind: 'tool',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'read',
    title: 'Read',
    description: 'Read a text file from the connected workspace or app workspace.',
    command: '/read-file',
    kind: 'tool',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: true
  },
  {
    id: 'read-mcp-resource',
    title: 'Read MCP Resource',
    description: 'Read a single resource from the local MCP bridge.',
    command: '/mcp-read',
    kind: 'mcp',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'send-message',
    title: 'Send Message',
    description: 'Send a follow-up message into an existing agent session.',
    command: '/agent-send',
    kind: 'agent',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'skill',
    title: 'Skill',
    description: 'Inspect or invoke a skill prompt explicitly by id.',
    command: '/skill',
    kind: 'skill',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'task-create',
    title: 'Task Create',
    description: 'Create a tracked task item.',
    command: '/task-create',
    kind: 'task',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'task-get',
    title: 'Task Get',
    description: 'Get a tracked task by id.',
    command: '/task-get',
    kind: 'task',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'task-list',
    title: 'Task List',
    description: 'List tracked tasks.',
    command: '/task-list',
    kind: 'task',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: true
  },
  {
    id: 'task-output',
    title: 'Task Output',
    description: 'Read the output file of a tracked task.',
    command: '/task-output',
    kind: 'task',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'task-stop',
    title: 'Task Stop',
    description: 'Stop a running tracked task.',
    command: '/task-stop',
    kind: 'task',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'task-update',
    title: 'Task Update',
    description: 'Update a tracked task status or details.',
    command: '/task-update',
    kind: 'task',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'team-create',
    title: 'Team Create',
    description: 'Create an agent team and seed its member sessions.',
    command: '/team-create',
    kind: 'team',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'team-delete',
    title: 'Team Delete',
    description: 'Archive an agent team and leave its transcript intact.',
    command: '/team-delete',
    kind: 'team',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'todo-write',
    title: 'Todo Write',
    description: 'Replace the task list with checklist items from markdown or plain text.',
    command: '/todo',
    kind: 'task',
    permissionClass: 'confirm_once',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'tool-search',
    title: 'Tool Search',
    description: 'Search built-in tools, skills, schedules, tasks, and MCP resources.',
    command: '/tool-search',
    kind: 'tool',
    permissionClass: 'none',
    availability: 'available',
    autoRoutable: true
  },
  {
    id: 'web-fetch',
    title: 'Web Fetch',
    description: 'Fetch a remote URL and return a bounded text excerpt.',
    command: '/fetch',
    kind: 'tool',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  },
  {
    id: 'write',
    title: 'Write',
    description: 'Create or overwrite a local text file inside the allowed workspace boundary.',
    command: '/write',
    kind: 'tool',
    permissionClass: 'always_confirm',
    availability: 'available',
    autoRoutable: false
  }
].map((definition) => toolDefinitionSchema.parse(definition));

export interface CapabilityToolExecutionResult {
  assistantContent: string;
  toolInvocations: ToolInvocation[];
  contextSources: ContextSource[];
}

export interface CapabilityToolExecutionInput {
  toolId: string;
  prompt: string;
  workspaceRootPath?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
}

interface ProcessExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimOutput(value: string): string {
  const normalized = value.trim();

  if (normalized.length <= MAX_PROCESS_OUTPUT) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PROCESS_OUTPUT)}\n... output truncated ...`;
}

function summarize(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized.slice(0, 300) : null;
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath).toLowerCase();
  const normalizedDirectory = path.resolve(directoryPath).toLowerCase();

  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`)
  );
}

function parseLooseJson<T>(prompt: string): T | null {
  return (parseJsonishRecord(prompt) as T | null) ?? null;
}

function parsePathAndContent(prompt: string): { filePath: string; content: string } | null {
  const jsonPayload = parseLooseJson<{
    filePath?: string;
    file_path?: string;
    path?: string;
    content?: string;
  }>(prompt);

  if (jsonPayload) {
    const filePath = jsonPayload.filePath ?? jsonPayload.file_path ?? jsonPayload.path;
    if (filePath && typeof jsonPayload.content === 'string') {
      return { filePath, content: jsonPayload.content };
    }
  }

  const normalized = prompt.replace(/\r\n/g, '\n').trim();
  const separator = '\n---\n';
  const separatorIndex = normalized.indexOf(separator);

  if (separatorIndex === -1) {
    return null;
  }

  const filePath = normalized.slice(0, separatorIndex).trim();
  const content = normalized.slice(separatorIndex + separator.length);

  return filePath && content
    ? {
        filePath,
        content
      }
    : null;
}

type EditInput =
  | { kind: 'range'; filePath: string; startLine: number; endLine: number; newText: string }
  | { kind: 'insert'; filePath: string; line: number; newText: string };

function parseEditInput(prompt: string): EditInput | null {
  const j = parseLooseJson<{
    filePath?: string;
    file_path?: string;
    path?: string;
    startLine?: number;
    start_line?: number;
    endLine?: number;
    end_line?: number;
    line?: number;
    operation?: string;
    newText?: string;
    new_text?: string;
    content?: string;
    // old format detection
    search?: unknown;
    oldText?: unknown;
    old_text?: unknown;
  }>(prompt);

  if (!j) return null;

  const filePath = (j.filePath ?? j.file_path ?? j.path ?? '').trim();
  if (!filePath) return null;

  if (j.search !== undefined || j.oldText !== undefined || j.old_text !== undefined) {
    throw new Error(
      'edit no longer uses search/replace. Use line-based format: ' +
        '{ filePath, startLine, endLine, newText } to replace a range, or ' +
        '{ filePath, line, operation: "insert_after", newText } to insert. ' +
        'Read the file first to get exact line numbers.'
    );
  }

  const newText = String(j.newText ?? j.new_text ?? j.content ?? '');
  const op = (j.operation ?? 'replace').toLowerCase();

  if (op === 'insert_after' || op === 'insert') {
    return { kind: 'insert', filePath, line: j.line ?? 0, newText };
  }

  const startLine = j.startLine ?? j.start_line;
  const endLine = j.endLine ?? j.end_line ?? startLine;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return null;

  return { kind: 'range', filePath, startLine, endLine, newText };
}

function applyLineEdit(originalContents: string, edit: EditInput): string {
  const hasCrlf = originalContents.includes('\r\n');
  const normalized = hasCrlf ? originalContents.replace(/\r\n/g, '\n') : originalContents;
  const trailingNewline = normalized.endsWith('\n');
  const lines = (trailingNewline ? normalized.slice(0, -1) : normalized).split('\n');
  const totalLines = lines.length;

  const toLines = (text: string): string[] => {
    const n = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return n === '' ? [] : n.split('\n').map((line) => line.replace(/^\d+\t/, ''));
  };

  let result: string[];

  if (edit.kind === 'range') {
    const start = edit.startLine - 1;
    const end = edit.endLine - 1;
    if (start < 0 || end >= totalLines || start > end) {
      throw new Error(
        `Line range ${edit.startLine}–${edit.endLine} is out of bounds (file has ${totalLines} lines).`
      );
    }
    result = [...lines.slice(0, start), ...toLines(edit.newText), ...lines.slice(end + 1)];
  } else {
    const after = edit.line;
    if (after < 0 || after > totalLines) {
      throw new Error(
        `Insert line ${edit.line} is out of bounds (file has ${totalLines} lines).`
      );
    }
    result = [...lines.slice(0, after), ...toLines(edit.newText), ...lines.slice(after)];
  }

  const joined = result.join('\n') + (trailingNewline ? '\n' : '');
  return hasCrlf ? joined.replace(/\n/g, '\r\n') : joined;
}

function parseQuestionInput(prompt: string): { question: string; options: string[] } | null {
  const jsonPayload = parseLooseJson<{ question?: string; options?: string[] }>(prompt);

  if (
    jsonPayload?.question &&
    Array.isArray(jsonPayload.options) &&
    jsonPayload.options.length >= 2
  ) {
    return {
      question: jsonPayload.question,
      options: jsonPayload.options.map((option) => `${option}`)
    };
  }

  const [questionPart, optionsPart] = prompt.split('::');

  if (!questionPart || !optionsPart) {
    return null;
  }

  const options = optionsPart
    .split('|')
    .map((option) => option.trim())
    .filter(Boolean);

  return questionPart.trim() && options.length >= 2
    ? {
        question: questionPart.trim(),
        options
      }
    : null;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const escaped = normalized.replace(/([.+^=!:${}()|[\]/\\])/g, '\\$1');
  const regexSource = escaped
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/::DOUBLE_STAR::/g, '.*');

  return new RegExp(`^${regexSource}$`, 'i');
}

function createInvocation(input: {
  toolId: string;
  displayName: string;
  status: ToolInvocation['status'];
  inputSummary: string;
  outputSummary: string | null;
  outputText?: string | null;
  errorMessage: string | null;
}): ToolInvocation {
  const timestamp = nowIso();

  return toolInvocationSchema.parse({
    id: randomUUID(),
    toolId: input.toolId,
    displayName: input.displayName,
    status: input.status,
    inputSummary: input.inputSummary,
    outputSummary: input.outputSummary,
    outputText: input.outputText ?? null,
    errorMessage: input.errorMessage,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function attachDetailedToolOutput(
  result: CapabilityToolExecutionResult
): CapabilityToolExecutionResult {
  const outputText = result.assistantContent.trim();

  if (!outputText || result.toolInvocations.length !== 1) {
    return result;
  }

  const [invocation] = result.toolInvocations;

  if (invocation?.outputText?.trim()) {
    return result;
  }

  return {
    ...result,
    toolInvocations: [
      toolInvocationSchema.parse({
        ...invocation,
        outputText
      })
    ]
  };
}

function createSource(input: {
  label: string;
  excerpt: string;
  sourcePath: string | null;
  score?: number | null;
}): ContextSource {
  return contextSourceSchema.parse({
    id: randomUUID(),
    kind: 'document_chunk',
    label: input.label,
    excerpt: input.excerpt,
    sourcePath: input.sourcePath,
    documentId: null,
    score: input.score ?? null
  });
}

async function readSafeTextFile(filePath: string): Promise<string> {
  if (isBinaryExtension(filePath)) {
    throw new Error(`Cannot read \`${path.basename(filePath)}\` — binary files are not supported.`);
  }

  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error('The requested path is not a file.');
  }

  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error('The requested file exceeds the safe text-read limit.');
  }

  const buffer = await readFile(filePath);

  if (buffer.includes(0)) {
    throw new Error('The requested file appears to be binary.');
  }

  return buffer.toString('utf8').slice(0, MAX_FILE_CHARACTERS);
}

async function walkWorkspaceFiles(rootPath: string): Promise<string[]> {
  const pendingDirectories = [rootPath];
  const files: string[] = [];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.shift();

    if (!currentDirectory) {
      break;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          pendingDirectories.push(entryPath);
        }

        continue;
      }

      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

export class CapabilityService {
  private readonly scheduleHandles = new Map<string, NodeJS.Timeout>();
  private readonly monitorProcesses = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly appPath: string,
    private readonly repository: CapabilityRepository,
    private readonly chatRepository: ChatRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly settingsProvider: { get: () => UserSettings },
    private readonly ollamaClient: OllamaClient,
    private readonly nvidiaClient: NvidiaClient,
    private readonly logger: Logger,
    private readonly runtimeDataPath = path.join(appPath, 'data')
  ) {}

  initialize(): void {
    this.rehydrateSchedules();
  }

  listDefinitions(): ToolDefinition[] {
    return [...capabilityDefinitions];
  }

  getById(toolId: string): ToolDefinition | null {
    return capabilityDefinitions.find((definition) => definition.id === toolId) ?? null;
  }

  listPermissions(): CapabilityPermission[] {
    return this.repository.listPermissionGrants();
  }

  grantPermission(input: CapabilityPermissionInput): CapabilityPermission {
    const permission = this.repository.upsertPermissionGrant(input);
    this.repository.writeAuditEvent({
      category: 'permission',
      action: `${input.capabilityId}:granted`,
      outcome: 'granted',
      summary: `Granted ${input.capabilityId} for ${input.scopeKind}`,
      payload: {
        scopeId: input.scopeId ?? null,
        expiresAt: input.expiresAt ?? null
      }
    });
    return permission;
  }

  revokePermission(input: CapabilityPermissionInput): void {
    this.repository.revokePermissionGrant(input);
    this.repository.writeAuditEvent({
      category: 'permission',
      action: `${input.capabilityId}:revoked`,
      outcome: 'revoked',
      summary: `Revoked ${input.capabilityId} for ${input.scopeKind}`,
      payload: {
        scopeId: input.scopeId ?? null
      }
    });
  }

  listTasks(): CapabilityTask[] {
    return this.repository.listTasks();
  }

  getTask(taskId: string): CapabilityTask | null {
    return this.repository.getTask(taskId);
  }

  deleteTask(taskId: string): void {
    this.repository.deleteTask(taskId);
  }

  listSchedules(): ScheduledPrompt[] {
    return this.repository.listSchedules();
  }

  listAgents(): AgentSession[] {
    return this.repository.listAgentSessions();
  }

  listTeams(): TeamSession[] {
    return this.repository.listAgentTeams();
  }

  listWorktrees(): WorktreeSession[] {
    return this.repository.listWorktreeSessions();
  }

  getPlanState(): PlanState {
    return this.repository.getPlanState();
  }

  listAuditEvents(): AuditEventRecord[] {
    return this.repository.listAuditEvents();
  }

  async executeTool(input: CapabilityToolExecutionInput): Promise<CapabilityToolExecutionResult> {
    const definition = this.getById(input.toolId);

    if (!definition) {
      throw new Error(`Capability ${input.toolId} is not registered.`);
    }

    this.assertPermission(definition, input.workspaceId ?? null);
    this.repository.writeAuditEvent({
      category: 'capability',
      action: `${definition.id}:started`,
      outcome: 'started',
      summary: `${definition.title} started`,
      payload: {
        workspaceId: input.workspaceId ?? null
      }
    });

    try {
      const result = attachDetailedToolOutput(await this.runTool(definition, input));
      this.repository.writeAuditEvent({
        category: 'capability',
        action: `${definition.id}:completed`,
        outcome: 'completed',
        summary: `${definition.title} completed`,
        payload: {
          outputSummary: result.toolInvocations[0]?.outputSummary ?? null
        }
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Capability execution failed.';
      this.repository.writeAuditEvent({
        category: 'capability',
        action: `${definition.id}:failed`,
        outcome: 'failed',
        summary: `${definition.title} failed`,
        payload: {
          error: message
        }
      });
      throw error;
    }
  }

  private async runTool(
    definition: ToolDefinition,
    input: CapabilityToolExecutionInput
  ): Promise<CapabilityToolExecutionResult> {
    switch (definition.id) {
      case 'ask-user-question':
        return this.executeAskUserQuestion(input.prompt);
      case 'read':
        return this.executeRead(input.prompt, input.workspaceRootPath ?? null);
      case 'glob':
        return this.executeGlob(input.prompt, input.workspaceRootPath ?? null);
      case 'grep':
        return this.executeGrep(input.prompt, input.workspaceRootPath ?? null);
      case 'write':
        return this.executeWrite(input.prompt, input.workspaceRootPath ?? null);
      case 'edit':
        return this.executeEdit(input.prompt, input.workspaceRootPath ?? null);
      case 'bash':
        return this.executeShellCommand('bash', input.prompt, input.workspaceRootPath ?? null);
      case 'powershell':
        return this.executeShellCommand('powershell', input.prompt, input.workspaceRootPath ?? null);
      case 'monitor':
        return this.executeMonitor(input.prompt, input.workspaceRootPath ?? null);
      case 'task-create':
        return this.executeTaskCreate(input.prompt);
      case 'task-get':
        return this.executeTaskGet(input.prompt);
      case 'task-list':
        return this.executeTaskList();
      case 'task-output':
        return this.executeTaskOutput(input.prompt, input.workspaceRootPath ?? null);
      case 'task-stop':
        return this.executeTaskStop(input.prompt);
      case 'task-update':
        return this.executeTaskUpdate(input.prompt);
      case 'todo-write':
        return this.executeTodoWrite(input.prompt);
      case 'cron-create':
        return this.executeCronCreate(input.prompt);
      case 'cron-delete':
        return this.executeCronDelete(input.prompt);
      case 'cron-list':
        return this.executeCronList();
      case 'agent':
        return this.executeAgentCreate({
          prompt: input.prompt,
          conversationId: input.conversationId ?? null
        });
      case 'send-message':
        return this.executeAgentMessage(input.prompt);
      case 'team-create':
        return this.executeTeamCreate(input.prompt);
      case 'team-delete':
        return this.executeTeamDelete(input.prompt);
      case 'enter-plan-mode':
        return this.executeEnterPlanMode(input.conversationId ?? null);
      case 'exit-plan-mode':
        return this.executeExitPlanMode(input.conversationId ?? null, input.prompt);
      case 'enter-worktree':
        return this.executeEnterWorktree(input.prompt);
      case 'exit-worktree':
        return this.executeExitWorktree(input.prompt);
      case 'notebook-edit':
        return this.executeNotebookEdit(input.prompt, input.workspaceRootPath ?? null);
      case 'lsp':
        return this.executeLsp(input.prompt, input.workspaceRootPath ?? null);
      case 'list-mcp-resources':
        return this.executeListMcpResources();
      case 'read-mcp-resource':
        return this.executeReadMcpResource(input.prompt);
      case 'tool-search':
        return this.executeToolSearch(input.prompt);
      case 'web-fetch':
        return this.executeWebFetch(input.prompt);
      case 'skill':
        return this.executeSkill(input.prompt);
      default:
        throw new Error(`Capability ${definition.id} does not have an execution handler yet.`);
    }
  }

  private assertPermission(definition: ToolDefinition, workspaceId: string | null): void {
    if (definition.permissionClass === 'none') {
      return;
    }

    const workspaceScopedGrant =
      workspaceId === null
        ? null
        : this.repository.getPermissionGrant(definition.id, 'workspace', workspaceId);
    const globalGrant = this.repository.getPermissionGrant(definition.id, 'global', null);
    const sessionGrant = this.repository.getPermissionGrant(definition.id, 'session', null);
    const grant = workspaceScopedGrant ?? globalGrant ?? sessionGrant;

    if (grant && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now())) {
      return;
    }

    this.repository.writeAuditEvent({
      category: 'permission',
      action: `${definition.id}:denied`,
      outcome: 'denied',
      summary: `${definition.title} requires approval`,
      payload: {
        workspaceId
      }
    });

    throw new Error(
      `${definition.title} requires approval before it can run. Grant it from Settings > Agentic Tools.`
    );
  }

  private resolveAllowedPath(candidatePath: string, workspaceRootPath: string | null): string {
    const resolvedPath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(workspaceRootPath ?? this.appPath, candidatePath);
    const allowedRoots = [this.appPath, workspaceRootPath].filter(
      (value): value is string => Boolean(value)
    );
    const withinAllowedRoot = allowedRoots.some((rootPath) =>
      isWithinDirectory(resolvedPath, rootPath)
    );

    if (!withinAllowedRoot) {
      throw new Error(
        'This capability can only access the app workspace or the connected workspace folder.'
      );
    }

    return resolvedPath;
  }

  private executeAskUserQuestion(prompt: string): CapabilityToolExecutionResult {
    const parsed = parseQuestionInput(prompt);

    if (!parsed) {
      throw new Error(
        'Ask User Question expects `question :: option 1 | option 2` or equivalent JSON.'
      );
    }

    return {
      assistantContent: [
        '### Ask User Question',
        '',
        parsed.question,
        '',
        ...parsed.options.map((option, index) => `${index + 1}. ${option}`)
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'ask-user-question',
          displayName: 'Ask User Question',
          status: 'completed',
          inputSummary: parsed.question,
          outputSummary: `${parsed.options.length} option(s)`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeRead(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const candidatePath = extractPromptPathCandidate(prompt);

    if (!candidatePath) {
      throw new Error('Read expects a file path.');
    }

    const resolvedPath = this.resolveAllowedPath(candidatePath, workspaceRootPath);
    const contents = await readSafeTextFile(resolvedPath);

    const numbered = contents
      .split('\n')
      .map((line, i) => `${i + 1}\t${line}`)
      .join('\n');

    return {
      assistantContent: `### Read\n\n\`${resolvedPath}\`\n\n\`\`\`text\n${numbered}\n\`\`\``,
      toolInvocations: [
        createInvocation({
          toolId: 'read',
          displayName: 'Read',
          status: 'completed',
          inputSummary: resolvedPath,
          outputSummary: summarize(contents),
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: path.basename(resolvedPath),
          excerpt: contents.slice(0, 600) || '(empty file)',
          sourcePath: resolvedPath
        })
      ]
    };
  }

  private async executeGlob(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('Glob requires a connected workspace folder.');
    }

    const pattern = prompt.trim() || '**/*';
    const matcher = globToRegExp(pattern);
    const files = (await walkWorkspaceFiles(workspaceRootPath))
      .map((filePath) => path.relative(workspaceRootPath, filePath).replace(/\\/g, '/'))
      .filter((relativePath) => matcher.test(relativePath))
      .slice(0, 200);

    return {
      assistantContent:
        files.length > 0
          ? ['### Glob', '', `Pattern: \`${pattern}\``, '', ...files.map((file) => `- ${file}`)].join(
              '\n'
            )
          : `### Glob\n\nNo files matched \`${pattern}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'glob',
          displayName: 'Glob',
          status: 'completed',
          inputSummary: pattern,
          outputSummary: `${files.length} match(es)`,
          errorMessage: null
        })
      ],
      contextSources: files.map((filePath) =>
        createSource({
          label: filePath,
          excerpt: `Glob match: ${filePath}`,
          sourcePath: path.join(workspaceRootPath, filePath)
        })
      )
    };
  }

  private async executeGrep(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('Grep requires a connected workspace folder.');
    }

    const query = prompt.trim();

    if (!query) {
      throw new Error('Grep expects a plain-text search query.');
    }

    const matches: ContextSource[] = [];
    const files = await walkWorkspaceFiles(workspaceRootPath);

    for (const filePath of files) {
      if (!TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        continue;
      }

      const contents = await readSafeTextFile(filePath).catch(() => null);

      if (!contents || !contents.toLowerCase().includes(query.toLowerCase())) {
        continue;
      }

      const relativePath = path.relative(workspaceRootPath, filePath) || path.basename(filePath);
      const lowerContents = contents.toLowerCase();
      const matchIndex = lowerContents.indexOf(query.toLowerCase());
      const excerpt = contents
        .slice(Math.max(0, matchIndex - 80), Math.min(contents.length, matchIndex + 180))
        .trim();

      matches.push(
        createSource({
          label: relativePath,
          excerpt,
          sourcePath: filePath
        })
      );

      if (matches.length >= 20) {
        break;
      }
    }

    return {
      assistantContent:
        matches.length > 0
          ? [
              '### Grep',
              '',
              `Query: \`${query}\``,
              '',
              ...matches.flatMap((match, index) => [
                `${index + 1}. \`${match.label}\``,
                `   ${match.excerpt.replace(/\n/g, ' ')}`
              ])
            ].join('\n')
          : `### Grep\n\nNo workspace matches were found for \`${query}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'grep',
          displayName: 'Grep',
          status: 'completed',
          inputSummary: query,
          outputSummary: `${matches.length} match(es)`,
          errorMessage: null
        })
      ],
      contextSources: matches
    };
  }

  private async executeWrite(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const parsed = parsePathAndContent(prompt);

    if (!parsed) {
      throw new Error('Write expects `path\\n---\\ncontent` or equivalent JSON.');
    }

    const resolvedPath = this.resolveAllowedPath(parsed.filePath, workspaceRootPath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, parsed.content, 'utf8');

    return {
      assistantContent: `### Write\n\nWrote \`${resolvedPath}\` (${parsed.content.length} characters).`,
      toolInvocations: [
        createInvocation({
          toolId: 'write',
          displayName: 'Write',
          status: 'completed',
          inputSummary: resolvedPath,
          outputSummary: `${parsed.content.length} characters`,
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: path.basename(resolvedPath),
          excerpt: parsed.content.slice(0, 600),
          sourcePath: resolvedPath
        })
      ]
    };
  }

  private async executeEdit(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const parsed = parseEditInput(prompt);

    if (!parsed) {
      throw new Error(
        'edit expects JSON: { filePath, startLine, endLine, newText } to replace lines, or ' +
          '{ filePath, line, operation: "insert_after", newText } to insert. ' +
          'Read the file first to get exact line numbers.'
      );
    }

    const resolvedPath = this.resolveAllowedPath(parsed.filePath, workspaceRootPath);
    const originalContents = await readSafeTextFile(resolvedPath);
    const nextContents = applyLineEdit(originalContents, { ...parsed, filePath: resolvedPath });

    await writeFile(resolvedPath, nextContents, 'utf8');

    const opSummary =
      parsed.kind === 'range'
        ? `Replaced lines ${parsed.startLine}–${parsed.endLine}`
        : `Inserted after line ${parsed.line}`;

    return {
      assistantContent: `### Edit\n\n${opSummary} in \`${resolvedPath}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'edit',
          displayName: 'Edit',
          status: 'completed',
          inputSummary: resolvedPath,
          outputSummary: opSummary,
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: path.basename(resolvedPath),
          excerpt: nextContents.slice(0, 600),
          sourcePath: resolvedPath
        })
      ]
    };
  }

  private async executeShellCommand(
    shellKind: 'bash' | 'powershell',
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const command = prompt.trim();

    if (!command) {
      throw new Error(`${shellKind === 'bash' ? 'Bash' : 'PowerShell'} expects a command string.`);
    }

    const result = await this.runProcess(shellKind, command, workspaceRootPath);
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

    return {
      assistantContent: [
        `### ${shellKind === 'bash' ? 'Bash' : 'PowerShell'}`,
        '',
        `Command: \`${command}\``,
        result.stdout ? `\nStdout\n\n\`\`\`text\n${result.stdout}\n\`\`\`` : '',
        result.stderr ? `\nStderr\n\n\`\`\`text\n${result.stderr}\n\`\`\`` : '',
        '',
        `Exit code: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}`
      ]
        .filter(Boolean)
        .join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: shellKind,
          displayName: shellKind === 'bash' ? 'Bash' : 'PowerShell',
          status:
            result.exitCode !== null && !result.timedOut ? 'completed' : 'failed',
          inputSummary: command,
          outputSummary: summarize(
            `${combinedOutput}${combinedOutput ? '\n' : ''}Exit code: ${result.exitCode ?? 'unknown'}`
          ),
          errorMessage:
            result.exitCode !== null && !result.timedOut
              ? null
              : summarize(result.stderr || `Exit code ${result.exitCode}`)
        })
      ],
      contextSources: []
    };
  }

  private async executeMonitor(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const command = prompt.trim();

    if (!command) {
      throw new Error('Monitor expects a command string.');
    }

    const task = this.repository.createTask({
      title: `Monitor: ${command.slice(0, 72)}`,
      details: command
    });
    const outputDirectory = path.join(this.runtimeDataPath, 'monitor-output');
    const outputPath = path.join(outputDirectory, `${task.id}.log`);
    await mkdir(outputDirectory, { recursive: true });
    const childProcess = spawn('powershell', ['-NoProfile', '-Command', command], {
      cwd: workspaceRootPath ?? this.appPath,
      stdio: 'pipe'
    });
    this.monitorProcesses.set(task.id, childProcess);
    this.repository.updateTask({
      taskId: task.id,
      status: 'in_progress',
      outputPath
    });

    let accumulatedOutput = '';
    const handleChunk = (chunk: string) => {
      accumulatedOutput += chunk;
      void writeFile(outputPath, accumulatedOutput, 'utf8');
    };

    childProcess.stdout.on('data', (chunk: Buffer | string) => {
      handleChunk(chunk.toString());
    });
    childProcess.stderr.on('data', (chunk: Buffer | string) => {
      handleChunk(chunk.toString());
    });
    childProcess.once('exit', (code) => {
      this.monitorProcesses.delete(task.id);
      this.repository.updateTask({
        taskId: task.id,
        status: code === 0 ? 'completed' : 'failed',
        outputPath
      });
    });

    return {
      assistantContent: `### Monitor\n\nStarted background monitor task \`${task.id}\` for \`${command}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'monitor',
          displayName: 'Monitor',
          status: 'completed',
          inputSummary: command,
          outputSummary: `Task ${task.id}`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTaskCreate(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{
      title?: string;
      details?: string;
      parentTaskId?: string;
    }>(prompt);
    const task = this.repository.createTask({
      title: payload?.title?.trim() || prompt.trim() || 'Untitled task',
      details: payload?.details?.trim() || undefined,
      parentTaskId: payload?.parentTaskId
    });

    return {
      assistantContent: `### Task Create\n\nCreated task \`${task.id}\`: ${task.title}`,
      toolInvocations: [
        createInvocation({
          toolId: 'task-create',
          displayName: 'Task Create',
          status: 'completed',
          inputSummary: task.title,
          outputSummary: task.id,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTaskGet(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ taskId?: string }>(prompt);
    const taskId = payload?.taskId?.trim() || prompt.trim();

    if (!taskId) {
      throw new Error('Task Get expects a task id.');
    }

    const task = this.repository.getTask(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} was not found.`);
    }

    return {
      assistantContent: [
        '### Task Get',
        '',
        `- ID: ${task.id}`,
        `- Title: ${task.title}`,
        `- Status: ${task.status}`,
        task.details ? `- Details: ${task.details}` : '',
        task.outputPath ? `- Output: ${task.outputPath}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'task-get',
          displayName: 'Task Get',
          status: 'completed',
          inputSummary: task.id,
          outputSummary: task.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTaskList(): CapabilityToolExecutionResult {
    const tasks = this.repository.listTasks();

    return {
      assistantContent:
        tasks.length > 0
          ? [
              '### Task List',
              '',
              ...tasks.map((task) => `- ${task.id} | ${task.status} | ${task.title}`)
            ].join('\n')
          : '### Task List\n\nNo tasks are currently tracked.',
      toolInvocations: [
        createInvocation({
          toolId: 'task-list',
          displayName: 'Task List',
          status: 'completed',
          inputSummary: 'all tasks',
          outputSummary: `${tasks.length} task(s)`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeTaskOutput(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ taskId?: string }>(prompt);
    const taskId = payload?.taskId?.trim() || prompt.trim();

    if (!taskId) {
      throw new Error('Task Output expects a task id.');
    }

    const task = this.repository.getTask(taskId);

    if (!task?.outputPath) {
      throw new Error(`Task ${taskId} does not have an output file.`);
    }

    const resolvedPath = this.resolveAllowedPath(task.outputPath, workspaceRootPath);
    const contents = await readSafeTextFile(resolvedPath);

    return {
      assistantContent: `### Task Output\n\n\`${task.id}\`\n\n\`\`\`text\n${contents}\n\`\`\``,
      toolInvocations: [
        createInvocation({
          toolId: 'task-output',
          displayName: 'Task Output',
          status: 'completed',
          inputSummary: task.id,
          outputSummary: summarize(contents),
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: path.basename(resolvedPath),
          excerpt: contents.slice(0, 600) || '(empty file)',
          sourcePath: resolvedPath
        })
      ]
    };
  }

  private executeTaskStop(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ taskId?: string }>(prompt);
    const taskId = payload?.taskId?.trim() || prompt.trim();

    if (!taskId) {
      throw new Error('Task Stop expects a task id.');
    }

    const childProcess = this.monitorProcesses.get(taskId);

    if (childProcess) {
      childProcess.kill();
      this.monitorProcesses.delete(taskId);
    }

    const task = this.repository.updateTask({
      taskId,
      status: 'cancelled'
    });

    return {
      assistantContent: `### Task Stop\n\nStopped task \`${task.id}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'task-stop',
          displayName: 'Task Stop',
          status: 'completed',
          inputSummary: task.id,
          outputSummary: task.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTaskUpdate(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{
      taskId?: string;
      status?: CapabilityTask['status'];
      details?: string | null;
      title?: string;
      outputPath?: string | null;
    }>(prompt);

    if (payload?.taskId) {
      const task = this.repository.updateTask({
        taskId: payload.taskId,
        status: payload.status,
        details: payload.details,
        title: payload.title,
        outputPath: payload.outputPath
      });

      return {
        assistantContent: `### Task Update\n\nUpdated task \`${task.id}\` to \`${task.status}\`.`,
        toolInvocations: [
          createInvocation({
            toolId: 'task-update',
            displayName: 'Task Update',
            status: 'completed',
            inputSummary: task.id,
            outputSummary: task.status,
            errorMessage: null
          })
        ],
        contextSources: []
      };
    }

    const [taskId, statusCandidate, ...detailsParts] = prompt.split('::').map((part) => part.trim());

    if (!taskId) {
      throw new Error('Task Update expects `taskId :: status :: details`.');
    }

    const status =
      statusCandidate === 'pending' ||
      statusCandidate === 'in_progress' ||
      statusCandidate === 'completed' ||
      statusCandidate === 'cancelled' ||
      statusCandidate === 'failed'
        ? statusCandidate
        : undefined;
    const task = this.repository.updateTask({
      taskId,
      status,
      details: detailsParts.length > 0 ? detailsParts.join('::') : undefined
    });

    return {
      assistantContent: `### Task Update\n\nUpdated task \`${task.id}\` to \`${task.status}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'task-update',
          displayName: 'Task Update',
          status: 'completed',
          inputSummary: task.id,
          outputSummary: task.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTodoWrite(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ items?: string[] }>(prompt);
    const items =
      payload?.items && Array.isArray(payload.items)
        ? payload.items.map((item) => `${item}`.trim()).filter(Boolean)
        : prompt
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => line.replace(/^- \[[ xX]\]\s*/, '').trim())
            .filter(Boolean);

    if (items.length === 0) {
      throw new Error('Todo Write expects at least one checklist item.');
    }

    const createdTasks = items.map((item) => this.repository.createTask({ title: item }));

    return {
      assistantContent: [
        '### Todo Write',
        '',
        `Created ${createdTasks.length} task(s):`,
        ...createdTasks.map((task) => `- \`${task.id}\` | ${task.title}`)
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'todo-write',
          displayName: 'Todo Write',
          status: 'completed',
          inputSummary: `${createdTasks.length} item(s)`,
          outputSummary: `${createdTasks.length} task(s) created`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeCronCreate(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{
      title?: string;
      prompt?: string;
      kind?: ScheduledPrompt['kind'];
      intervalSeconds?: number;
      runAt?: string;
    }>(prompt);
    const intervalMatch = prompt.match(
      /^every\s+(\d+)\s*(seconds?|minutes?|hours?)\s*::\s*([^\n]+?)\s*::\s*([\s\S]+)$/i
    );
    const onceMatch = prompt.match(/^at\s+([^\n:]+?)\s*::\s*([^\n]+?)\s*::\s*([\s\S]+)$/i);

    let schedule: ScheduledPrompt;

    if (
      payload?.kind === 'interval' &&
      payload.title?.trim() &&
      payload.prompt?.trim() &&
      typeof payload.intervalSeconds === 'number' &&
      Number.isFinite(payload.intervalSeconds) &&
      payload.intervalSeconds > 0
    ) {
      const intervalSeconds = Math.floor(payload.intervalSeconds);
      const nextRunAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
      schedule = this.repository.createSchedule(
        {
          title: payload.title.trim(),
          prompt: payload.prompt.trim(),
          kind: 'interval',
          intervalSeconds
        },
        nextRunAt
      );
    } else if (
      payload?.kind === 'once' &&
      payload.title?.trim() &&
      payload.prompt?.trim() &&
      payload.runAt?.trim()
    ) {
      const runAt = new Date(payload.runAt.trim()).toISOString();
      schedule = this.repository.createSchedule(
        {
          title: payload.title.trim(),
          prompt: payload.prompt.trim(),
          kind: 'once',
          runAt
        },
        runAt
      );
    } else if (intervalMatch?.[1] && intervalMatch[2] && intervalMatch[3] && intervalMatch[4]) {
      const value = Number(intervalMatch[1]);
      const unit = intervalMatch[2].toLowerCase();
      const multiplier =
        unit.startsWith('hour') ? 3600 : unit.startsWith('minute') ? 60 : 1;
      const intervalSeconds = value * multiplier;
      const nextRunAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
      schedule = this.repository.createSchedule(
        {
          title: intervalMatch[3].trim(),
          prompt: intervalMatch[4].trim(),
          kind: 'interval',
          intervalSeconds
        },
        nextRunAt
      );
    } else if (onceMatch?.[1] && onceMatch[2] && onceMatch[3]) {
      const runAt = new Date(onceMatch[1].trim()).toISOString();
      schedule = this.repository.createSchedule(
        {
          title: onceMatch[2].trim(),
          prompt: onceMatch[3].trim(),
          kind: 'once',
          runAt
        },
        runAt
      );
    } else {
      throw new Error(
        'Cron Create expects `every 30 minutes :: Title :: Prompt` or `at 2026-04-12T10:00:00Z :: Title :: Prompt`.'
      );
    }

    this.armSchedule(schedule);

    return {
      assistantContent: `### Cron Create\n\nCreated schedule \`${schedule.id}\` (${schedule.kind}).`,
      toolInvocations: [
        createInvocation({
          toolId: 'cron-create',
          displayName: 'Cron Create',
          status: 'completed',
          inputSummary: schedule.title,
          outputSummary: schedule.id,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeCronDelete(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ scheduleId?: string }>(prompt);
    const scheduleId = payload?.scheduleId?.trim() || prompt.trim();

    if (!scheduleId) {
      throw new Error('Cron Delete expects a schedule id.');
    }

    const existingHandle = this.scheduleHandles.get(scheduleId);

    if (existingHandle) {
      clearTimeout(existingHandle);
      this.scheduleHandles.delete(scheduleId);
    }

    this.repository.deleteSchedule(scheduleId);

    return {
      assistantContent: `### Cron Delete\n\nDeleted schedule \`${scheduleId}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'cron-delete',
          displayName: 'Cron Delete',
          status: 'completed',
          inputSummary: scheduleId,
          outputSummary: 'deleted',
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeCronList(): CapabilityToolExecutionResult {
    const schedules = this.repository.listSchedules();

    return {
      assistantContent:
        schedules.length > 0
          ? [
              '### Cron List',
              '',
              ...schedules.map(
                (schedule) =>
                  `- ${schedule.id} | ${schedule.kind} | ${schedule.title} | next: ${schedule.nextRunAt ?? 'n/a'}`
              )
            ].join('\n')
          : '### Cron List\n\nNo schedules are active.',
      toolInvocations: [
        createInvocation({
          toolId: 'cron-list',
          displayName: 'Cron List',
          status: 'completed',
          inputSummary: 'all schedules',
          outputSummary: `${schedules.length} schedule(s)`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeAgentCreate(input: {
    prompt: string;
    conversationId: string | null;
  }): Promise<CapabilityToolExecutionResult> {
    const session = this.repository.createAgentSession({
      prompt: input.prompt,
      parentConversationId: input.conversationId ?? undefined
    });
    this.repository.appendAgentMessage({
      sessionId: session.id,
      role: 'user',
      content: input.prompt
    });
    await this.runAgentTurn(session.id, input.prompt);
    const hydrated = this.repository.getAgentSession(session.id);

    return {
      assistantContent: [
        '### Agent',
        '',
        `Started agent session \`${session.id}\`.`,
        '',
        hydrated?.messages.at(-1)?.role === 'assistant'
          ? hydrated.messages.at(-1)?.content ?? ''
          : 'No agent reply was produced.'
      ]
        .filter(Boolean)
        .join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'agent',
          displayName: 'Agent',
          status: 'completed',
          inputSummary: input.prompt.slice(0, 160),
          outputSummary: session.id,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeAgentMessage(prompt: string): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ sessionId?: string; message?: string }>(prompt);
    const jsonSessionId = payload?.sessionId?.trim();
    const jsonMessage = payload?.message?.trim();

    if (jsonSessionId && jsonMessage) {
      this.repository.appendAgentMessage({
        sessionId: jsonSessionId,
        role: 'user',
        content: jsonMessage
      });
      await this.runAgentTurn(jsonSessionId, jsonMessage);
      const session = this.repository.getAgentSession(jsonSessionId);

      if (!session) {
        throw new Error(`Agent session ${jsonSessionId} was not found.`);
      }

      return {
        assistantContent: [
          '### Send Message',
          '',
          `Sent message to agent \`${session.id}\`.`,
          '',
          session.messages.at(-1)?.role === 'assistant'
            ? session.messages.at(-1)?.content ?? ''
            : 'No agent reply was produced.'
        ]
          .filter(Boolean)
          .join('\n'),
        toolInvocations: [
          createInvocation({
            toolId: 'send-message',
            displayName: 'Send Message',
            status: 'completed',
            inputSummary: jsonSessionId,
            outputSummary: session.status,
            errorMessage: null
          })
        ],
        contextSources: []
      };
    }

    const [sessionId, ...messageParts] = prompt.split('::');
    const normalizedSessionId = sessionId?.trim();
    const message = messageParts.join('::').trim();

    if (!normalizedSessionId || !message) {
      throw new Error('Send Message expects `sessionId :: message`.');
    }

    this.repository.appendAgentMessage({
      sessionId: normalizedSessionId,
      role: 'user',
      content: message
    });
    await this.runAgentTurn(normalizedSessionId, message);
    const session = this.repository.getAgentSession(normalizedSessionId);

    if (!session) {
      throw new Error(`Agent session ${normalizedSessionId} was not found.`);
    }

    return {
      assistantContent: [
        '### Send Message',
        '',
        `Sent message to agent \`${session.id}\`.`,
        '',
        session.messages.at(-1)?.role === 'assistant'
          ? session.messages.at(-1)?.content ?? ''
          : 'No agent reply was produced.'
      ]
        .filter(Boolean)
        .join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'send-message',
          displayName: 'Send Message',
          status: 'completed',
          inputSummary: normalizedSessionId,
          outputSummary: session.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeTeamCreate(prompt: string): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ title?: string; agentPrompts?: string[] }>(prompt);
    const jsonTitle = payload?.title?.trim();
    const jsonPrompts = (payload?.agentPrompts ?? []).map((part) => part.trim()).filter(Boolean);

    if (jsonTitle && jsonPrompts.length > 0) {
      const team = this.repository.createAgentTeam({
        title: jsonTitle,
        agentPrompts: jsonPrompts
      });

      for (const agentPrompt of jsonPrompts) {
        const session = this.repository.createAgentSession({
          prompt: agentPrompt,
          teamId: team.id
        });
        this.repository.appendAgentMessage({
          sessionId: session.id,
          role: 'user',
          content: agentPrompt
        });
        await this.runAgentTurn(session.id, agentPrompt);
      }

      const hydratedTeam =
        this.repository.listAgentTeams().find((item) => item.id === team.id) ?? team;

      return {
        assistantContent: `### Team Create\n\nCreated team \`${hydratedTeam.id}\` with ${hydratedTeam.memberIds.length} agent(s).`,
        toolInvocations: [
          createInvocation({
            toolId: 'team-create',
            displayName: 'Team Create',
            status: 'completed',
            inputSummary: hydratedTeam.title,
            outputSummary: `${hydratedTeam.memberIds.length} agent(s)`,
            errorMessage: null
          })
        ],
        contextSources: []
      };
    }

    const [title, prompts] = prompt.split('::');
    const agentPrompts = (prompts ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);

    if (!title?.trim() || agentPrompts.length === 0) {
      throw new Error('Team Create expects `Title :: prompt 1 | prompt 2`.');
    }

    const team = this.repository.createAgentTeam({
      title: title.trim(),
      agentPrompts
    });

    for (const agentPrompt of agentPrompts) {
      const session = this.repository.createAgentSession({
        prompt: agentPrompt,
        teamId: team.id
      });
      this.repository.appendAgentMessage({
        sessionId: session.id,
        role: 'user',
        content: agentPrompt
      });
      await this.runAgentTurn(session.id, agentPrompt);
    }

    const hydratedTeam = this.repository.listAgentTeams().find((item) => item.id === team.id) ?? team;

    return {
      assistantContent: `### Team Create\n\nCreated team \`${hydratedTeam.id}\` with ${hydratedTeam.memberIds.length} agent(s).`,
      toolInvocations: [
        createInvocation({
          toolId: 'team-create',
          displayName: 'Team Create',
          status: 'completed',
          inputSummary: hydratedTeam.title,
          outputSummary: `${hydratedTeam.memberIds.length} agent(s)`,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeTeamDelete(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ teamId?: string }>(prompt);
    const teamId = payload?.teamId?.trim() || prompt.trim();

    if (!teamId) {
      throw new Error('Team Delete expects a team id.');
    }

    const team = this.repository.archiveTeam(teamId);

    return {
      assistantContent: `### Team Delete\n\nArchived team \`${team.id}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'team-delete',
          displayName: 'Team Delete',
          status: 'completed',
          inputSummary: team.id,
          outputSummary: team.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeEnterPlanMode(conversationId: string | null): CapabilityToolExecutionResult {
    if (!conversationId) {
      throw new Error('Enter Plan Mode requires an active conversation.');
    }

    const planState = this.repository.upsertPlanState({
      conversationId,
      status: 'active',
      summary: 'Plan mode enabled.'
    });

    return {
      assistantContent: `### Enter Plan Mode\n\nPlan mode is now active for conversation \`${planState.conversationId}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'enter-plan-mode',
          displayName: 'Enter Plan Mode',
          status: 'completed',
          inputSummary: conversationId,
          outputSummary: planState.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeExitPlanMode(
    conversationId: string | null,
    prompt: string
  ): CapabilityToolExecutionResult {
    if (!conversationId) {
      throw new Error('Exit Plan Mode requires an active conversation.');
    }

    const summary = prompt.trim() || 'Plan mode disabled.';
    const planState = this.repository.upsertPlanState({
      conversationId,
      status: 'inactive',
      summary
    });

    return {
      assistantContent: `### Exit Plan Mode\n\nPlan mode is now inactive. Summary: ${planState.summary ?? 'No summary.'}`,
      toolInvocations: [
        createInvocation({
          toolId: 'exit-plan-mode',
          displayName: 'Exit Plan Mode',
          status: 'completed',
          inputSummary: conversationId,
          outputSummary: planState.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeEnterWorktree(prompt: string): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ repoRoot?: string; branch?: string }>(prompt);
    const [repoRootPart, branchPart] = prompt.split('::');
    const repoRoot = payload?.repoRoot?.trim() || repoRootPart?.trim();
    const branch = payload?.branch?.trim() || branchPart?.trim();

    if (!repoRoot || !branch) {
      throw new Error('Enter Worktree expects `repoRoot :: branch`.');
    }

    const resolvedRepoRoot = path.resolve(repoRoot);
    const worktreePath = path.join(
      resolvedRepoRoot,
      APP_WORKTREE_DIRECTORY_NAME,
      branch
    );
    const result = await this.runProcess(
      'powershell',
      `git -C "${resolvedRepoRoot}" worktree add "${worktreePath}" "${branch}"`,
      resolvedRepoRoot
    );

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Unable to create git worktree.');
    }

    const session = this.repository.createWorktreeSession({
      repoRoot: resolvedRepoRoot,
      worktreePath,
      branch
    });

    return {
      assistantContent: `### Enter Worktree\n\nCreated worktree \`${session.worktreePath}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'enter-worktree',
          displayName: 'Enter Worktree',
          status: 'completed',
          inputSummary: `${resolvedRepoRoot} :: ${branch}`,
          outputSummary: session.worktreePath,
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: branch,
          excerpt: session.worktreePath,
          sourcePath: session.worktreePath
        })
      ]
    };
  }

  private async executeExitWorktree(prompt: string): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ sessionId?: string }>(prompt);
    const sessionId = payload?.sessionId?.trim() || prompt.trim();

    if (!sessionId) {
      throw new Error('Exit Worktree expects a worktree session id.');
    }

    const session = this.repository.listWorktreeSessions().find((item) => item.id === sessionId);

    if (!session) {
      throw new Error(`Worktree session ${sessionId} was not found.`);
    }

    const result = await this.runProcess(
      'powershell',
      `git -C "${session.repoRoot}" worktree remove "${session.worktreePath}"`,
      session.repoRoot
    );

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Unable to remove git worktree.');
    }

    const closedSession = this.repository.closeWorktreeSession(session.id);

    return {
      assistantContent: `### Exit Worktree\n\nClosed worktree \`${closedSession.worktreePath}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'exit-worktree',
          displayName: 'Exit Worktree',
          status: 'completed',
          inputSummary: closedSession.id,
          outputSummary: closedSession.status,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async executeNotebookEdit(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{
      filePath?: string;
      cellIndex?: number;
      source?: string;
    }>(prompt);

    if (
      !payload?.filePath ||
      !Number.isInteger(payload.cellIndex) ||
      typeof payload.source !== 'string'
    ) {
      throw new Error('Notebook Edit expects JSON with `filePath`, `cellIndex`, and `source`.');
    }

    const resolvedPath = this.resolveAllowedPath(payload.filePath, workspaceRootPath);
    const contents = await readSafeTextFile(resolvedPath);
    const notebook = JSON.parse(contents) as {
      cells?: Array<{ source?: string[] | string }>;
    };
    const cellIndex = payload.cellIndex as number;
    const targetCell = notebook.cells?.[cellIndex];

    if (!targetCell) {
      throw new Error(`Notebook cell ${cellIndex} was not found.`);
    }

    targetCell.source = payload.source.endsWith('\n')
      ? [payload.source]
      : [`${payload.source}\n`];
    await writeFile(resolvedPath, JSON.stringify(notebook, null, 2), 'utf8');

    return {
      assistantContent: `### Notebook Edit\n\nUpdated notebook cell ${cellIndex} in \`${resolvedPath}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'notebook-edit',
          displayName: 'Notebook Edit',
          status: 'completed',
          inputSummary: `${resolvedPath}#${cellIndex}`,
          outputSummary: 'cell updated',
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: path.basename(resolvedPath),
          excerpt: payload.source.slice(0, 600),
          sourcePath: resolvedPath
        })
      ]
    };
  }

  private async executeLsp(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<CapabilityToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('LSP requires a connected workspace folder.');
    }

    const payload = parseLooseJson<{ action?: string; symbol?: string }>(prompt);
    const [actionPart, ...symbolParts] = prompt.trim().split(' ');
    const action = (payload?.action ?? actionPart)?.toLowerCase();
    const symbol = (payload?.symbol ?? symbolParts.join(' ')).trim();

    if (action !== 'definition' && action !== 'references' && action !== 'diagnostics') {
      throw new Error('LSP expects `definition <symbol>`, `references <symbol>`, or `diagnostics`.');
    }

    if (action === 'diagnostics') {
      const result = await this.runProcess('powershell', 'npm run typecheck', workspaceRootPath);

      return {
        assistantContent: [
          '### LSP',
          '',
          'Diagnostics',
          '',
          '```text',
          result.stdout || result.stderr || 'No diagnostics output.',
          '```'
        ].join('\n'),
        toolInvocations: [
          createInvocation({
            toolId: 'lsp',
            displayName: 'LSP',
            status: result.exitCode === 0 ? 'completed' : 'failed',
            inputSummary: 'diagnostics',
            outputSummary: summarize(result.stdout || result.stderr),
            errorMessage: result.exitCode === 0 ? null : summarize(result.stderr)
          })
        ],
        contextSources: []
      };
    }

    if (!symbol) {
      throw new Error(`LSP ${action} expects a symbol.`);
    }

    const files = await walkWorkspaceFiles(workspaceRootPath);
    const matches: ContextSource[] = [];

    for (const filePath of files) {
      if (!TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        continue;
      }

      const contents = await readSafeTextFile(filePath).catch(() => null);

      if (!contents) {
        continue;
      }

      const searchPattern =
        action === 'definition'
          ? new RegExp(
              `\\b(function|class|interface|type|const|let|var|export\\s+function|export\\s+class|export\\s+const)\\s+${symbol}\\b`,
              'i'
            )
          : new RegExp(`\\b${symbol}\\b`, 'i');

      if (!searchPattern.test(contents)) {
        continue;
      }

      const relativePath = path.relative(workspaceRootPath, filePath) || path.basename(filePath);
      const matchIndex = contents.search(searchPattern);
      const excerpt = contents
        .slice(Math.max(0, matchIndex - 80), Math.min(contents.length, matchIndex + 180))
        .trim();

      matches.push(
        createSource({
          label: relativePath,
          excerpt,
          sourcePath: filePath
        })
      );

      if (matches.length >= 20) {
        break;
      }
    }

    return {
      assistantContent:
        matches.length > 0
          ? [
              '### LSP',
              '',
              `${action} for \`${symbol}\``,
              '',
              ...matches.flatMap((match, index) => [
                `${index + 1}. \`${match.label}\``,
                `   ${match.excerpt.replace(/\n/g, ' ')}`
              ])
            ].join('\n')
          : `### LSP\n\nNo ${action} matches were found for \`${symbol}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'lsp',
          displayName: 'LSP',
          status: 'completed',
          inputSummary: `${action} ${symbol}`,
          outputSummary: `${matches.length} match(es)`,
          errorMessage: null
        })
      ],
      contextSources: matches
    };
  }

  private executeListMcpResources(): CapabilityToolExecutionResult {
    const resources = this.buildMcpResources();

    return {
      assistantContent:
        resources.length > 0
          ? [
              '### List MCP Resources',
              '',
              ...resources.map((resource) => `- ${resource.label}${resource.sourcePath ? ` (${resource.sourcePath})` : ''}`)
            ].join('\n')
          : '### List MCP Resources\n\nNo MCP resources are currently connected.',
      toolInvocations: [
        createInvocation({
          toolId: 'list-mcp-resources',
          displayName: 'List MCP Resources',
          status: 'completed',
          inputSummary: 'all resources',
          outputSummary: `${resources.length} resource(s)`,
          errorMessage: null
        })
      ],
      contextSources: resources
    };
  }

  private async executeReadMcpResource(prompt: string): Promise<CapabilityToolExecutionResult> {
    const payload = parseLooseJson<{ resource?: string }>(prompt);
    const resourcePath = payload?.resource?.trim() || prompt.trim();

    if (!resourcePath) {
      throw new Error('Read MCP Resource expects a resource label or file path.');
    }

    const resources = this.buildMcpResources();
    const resource = resources.find(
      (item) =>
        item.sourcePath === resourcePath ||
        item.label.toLowerCase() === resourcePath.toLowerCase()
    );

    if (!resource?.sourcePath) {
      throw new Error(`MCP resource ${resourcePath} was not found or has no readable local path.`);
    }

    const contents = await readSafeTextFile(resource.sourcePath);

    return {
      assistantContent: `### Read MCP Resource\n\n\`${resource.label}\`\n\n\`\`\`text\n${contents}\n\`\`\``,
      toolInvocations: [
        createInvocation({
          toolId: 'read-mcp-resource',
          displayName: 'Read MCP Resource',
          status: 'completed',
          inputSummary: resource.label,
          outputSummary: summarize(contents),
          errorMessage: null
        })
      ],
      contextSources: [resource]
    };
  }

  private executeToolSearch(prompt: string): CapabilityToolExecutionResult {
    const query = prompt.trim().toLowerCase();

    if (!query) {
      throw new Error('Tool Search expects a query string.');
    }

    const definitions = this.listDefinitions().filter((definition) =>
      `${definition.title} ${definition.description} ${definition.id}`.toLowerCase().includes(query)
    );
    const skills = this.skillRegistry
      .list()
      .filter((skill) =>
        `${skill.id} ${skill.title} ${skill.description}`.toLowerCase().includes(query)
      )
      .map((skill) =>
        createSource({
          label: `Skill: ${skill.id}`,
          excerpt: skill.description,
          sourcePath: null
        })
      );
    const tasks = this.repository
      .listTasks()
      .filter((task) =>
        `${task.id} ${task.title} ${task.details ?? ''} ${task.status}`
          .toLowerCase()
          .includes(query)
      )
      .map((task) =>
        createSource({
          label: `Task: ${task.title}`,
          excerpt: `${task.status}${task.details ? ` | ${task.details}` : ''}`,
          sourcePath: task.outputPath
        })
      );
    const schedules = this.repository
      .listSchedules()
      .filter((schedule) =>
        `${schedule.id} ${schedule.title} ${schedule.prompt} ${schedule.kind}`
          .toLowerCase()
          .includes(query)
      )
      .map((schedule) =>
        createSource({
          label: `Schedule: ${schedule.title}`,
          excerpt: `${schedule.kind} | next: ${schedule.nextRunAt ?? 'n/a'}`,
          sourcePath: null
        })
      );
    const agents = this.repository
      .listAgentSessions()
      .filter((session) =>
        `${session.id} ${session.title} ${session.status}`.toLowerCase().includes(query)
      )
      .map((session) =>
        createSource({
          label: `Agent: ${session.title}`,
          excerpt: `${session.status} | ${session.id}`,
          sourcePath: null
        })
      );
    const teams = this.repository
      .listAgentTeams()
      .filter((team) =>
        `${team.id} ${team.title} ${team.status}`.toLowerCase().includes(query)
      )
      .map((team) =>
        createSource({
          label: `Team: ${team.title}`,
          excerpt: `${team.status} | ${team.memberIds.length} member(s)`,
          sourcePath: null
        })
      );
    const worktrees = this.repository
      .listWorktreeSessions()
      .filter((session) =>
        `${session.id} ${session.branch} ${session.repoRoot} ${session.worktreePath} ${session.status}`
          .toLowerCase()
          .includes(query)
      )
      .map((session) =>
        createSource({
          label: `Worktree: ${session.branch}`,
          excerpt: `${session.status} | ${session.worktreePath}`,
          sourcePath: session.worktreePath
        })
      );
    const resources = this.buildMcpResources().filter((resource) =>
      `${resource.label} ${resource.excerpt} ${resource.sourcePath ?? ''}`
        .toLowerCase()
        .includes(query)
    );
    const contextSources = [
      ...skills,
      ...tasks,
      ...schedules,
      ...agents,
      ...teams,
      ...worktrees,
      ...resources
    ];

    return {
      assistantContent: [
        '### Tool Search',
        '',
        ...definitions.map((definition) => `- ${definition.title} (${definition.command})`),
        ...contextSources.map((source) => `- ${source.label}`)
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'tool-search',
          displayName: 'Tool Search',
          status: 'completed',
          inputSummary: query,
          outputSummary: `${definitions.length + contextSources.length} result(s)`,
          errorMessage: null
        })
      ],
      contextSources
    };
  }

  private async executeWebFetch(prompt: string): Promise<CapabilityToolExecutionResult> {
    const urlValue = prompt.trim();

    if (!urlValue) {
      throw new Error('Web Fetch expects a URL.');
    }

    const response = await fetch(urlValue, {
      headers: {
        'user-agent': APP_USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`Web Fetch failed with status ${response.status}.`);
    }

    const text = trimOutput(await response.text());

    return {
      assistantContent: `### Web Fetch\n\n\`${urlValue}\`\n\n\`\`\`text\n${text}\n\`\`\``,
      toolInvocations: [
        createInvocation({
          toolId: 'web-fetch',
          displayName: 'Web Fetch',
          status: 'completed',
          inputSummary: urlValue,
          outputSummary: summarize(text),
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: urlValue,
          excerpt: text.slice(0, 600),
          sourcePath: urlValue
        })
      ]
    };
  }

  private executeSkill(prompt: string): CapabilityToolExecutionResult {
    const payload = parseLooseJson<{ skillId?: string; prompt?: string }>(prompt);
    const [skillIdPart, ...remainderParts] = prompt.split('::');
    const skillId = (payload?.skillId ?? skillIdPart)?.trim().replace(/^@/, '');

    if (!skillId) {
      throw new Error('Skill expects `skill-id :: optional prompt`.');
    }

    const skill = this.skillRegistry.getById(skillId);

    if (!skill) {
      throw new Error(`Skill ${skillId} was not found.`);
    }

    const remainder = payload?.prompt?.trim() || remainderParts.join('::').trim();

    return {
      assistantContent: [
        '### Skill',
        '',
        `@${skill.id} — ${skill.title}`,
        '',
        skill.description,
        '',
        remainder
          ? `Suggested combined prompt:\n\n${skill.prompt}\n\nUser request:\n${remainder}`
          : skill.prompt
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'skill',
          displayName: 'Skill',
          status: 'completed',
          inputSummary: skill.id,
          outputSummary: skill.title,
          errorMessage: null
        })
      ],
      contextSources: [
        createSource({
          label: `Skill: ${skill.id}`,
          excerpt: skill.description,
          sourcePath: null
        })
      ]
    };
  }

  private async runAgentTurn(sessionId: string, latestUserMessage: string): Promise<void> {
    const settings = this.settingsProvider.get();
    const activeBackend = settings.textInferenceBackend;
    let model: string | undefined;

    if (activeBackend === 'nvidia') {
      const status = await this.nvidiaClient.getStatus(
        settings.nvidiaBaseUrl,
        settings.nvidiaApiKey
      );
      model =
        settings.codingModel.trim() ||
        settings.defaultModel.trim() ||
        status.models[0]?.name;

      if (!model || !status.configured) {
        this.repository.appendAgentMessage({
          sessionId,
          role: 'assistant',
          content: status.error ?? 'Add an NVIDIA API key in Settings before using this backend.'
        });
        this.repository.updateAgentSessionStatus(sessionId, 'failed');
        return;
      }
    } else {
      const status = await this.ollamaClient.getStatus(settings.ollamaBaseUrl);
      model =
        settings.codingModel.trim() ||
        settings.defaultModel.trim() ||
        status.models[0]?.name;

      if (!model) {
        this.repository.appendAgentMessage({
          sessionId,
          role: 'assistant',
          content: 'No Ollama model is configured for agent execution.'
        });
        this.repository.updateAgentSessionStatus(sessionId, 'failed');
        return;
      }
    }

    if (!model) {
      this.repository.appendAgentMessage({
        sessionId,
        role: 'assistant',
        content: 'No model is configured for agent execution.'
      });
      this.repository.updateAgentSessionStatus(sessionId, 'failed');
      return;
    }

    const session = this.repository.getAgentSession(sessionId);

    if (!session) {
      throw new Error(`Agent session ${sessionId} was not found.`);
    }

    this.repository.updateAgentSessionStatus(sessionId, 'running');

    const messages = [
      {
        role: 'system' as const,
        content:
          'You are an internal sub-agent. Produce a concise execution note or plan for the assigned task.'
      },
      ...session.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      {
        role: 'user' as const,
        content: latestUserMessage
      }
    ];

    try {
      const result =
        activeBackend === 'ollama'
          ? await this.ollamaClient.completeChat({
              baseUrl: settings.ollamaBaseUrl,
              model,
              messages
            })
          : await this.nvidiaClient.completeChat({
              baseUrl: settings.nvidiaBaseUrl,
              apiKey: settings.nvidiaApiKey,
              model,
              messages
            });

      this.repository.appendAgentMessage({
        sessionId,
        role: 'assistant',
        content: result.content || 'No output was produced.'
      });
      this.repository.updateAgentSessionStatus(sessionId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent execution failed.';
      this.repository.appendAgentMessage({
        sessionId,
        role: 'assistant',
        content: message
      });
      this.repository.updateAgentSessionStatus(sessionId, 'failed');
    }
  }

  private async runProcess(
    shellKind: 'bash' | 'powershell',
    command: string,
    cwd: string | null
  ): Promise<ProcessExecutionResult> {
    const childProcess =
      shellKind === 'bash'
        ? spawn('bash', ['-lc', command], {
            cwd: cwd ?? this.appPath,
            stdio: 'pipe'
          })
        : spawn('powershell', ['-NoProfile', '-Command', command], {
            cwd: cwd ?? this.appPath,
            stdio: 'pipe'
          });

    return await new Promise<ProcessExecutionResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        childProcess.kill();
        resolve({
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr || 'Process timed out.'),
          exitCode: null,
          timedOut: true
        });
      }, PROCESS_TIMEOUT_MS);

      childProcess.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      childProcess.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      childProcess.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
      childProcess.once('exit', (exitCode) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        resolve({
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          exitCode,
          timedOut: false
        });
      });
    });
  }

  private buildMcpResources(): ContextSource[] {
    const skills = this.skillRegistry.list().map((skill) =>
      createSource({
        label: skill.title,
        excerpt: skill.description,
        sourcePath: null
      })
    );
    const workspaces = this.chatRepository.listWorkspaces().map((workspace) =>
      createSource({
        label: `Workspace: ${workspace.name}`,
        excerpt: workspace.prompt ?? 'No workspace prompt configured.',
        sourcePath: workspace.rootPath
      })
    );

    return [...skills, ...workspaces];
  }

  private rehydrateSchedules(): void {
    for (const schedule of this.repository.listSchedules()) {
      if (schedule.enabled && schedule.nextRunAt) {
        this.armSchedule(schedule);
      }
    }
  }

  private armSchedule(schedule: ScheduledPrompt): void {
    const existingHandle = this.scheduleHandles.get(schedule.id);

    if (existingHandle) {
      clearTimeout(existingHandle);
    }

    if (!schedule.enabled || !schedule.nextRunAt) {
      return;
    }

    const delayMs = Math.max(0, new Date(schedule.nextRunAt).getTime() - Date.now());
    const handle = setTimeout(() => {
      void this.runScheduledPrompt(schedule.id);
    }, delayMs);
    this.scheduleHandles.set(schedule.id, handle);
  }

  private async runScheduledPrompt(scheduleId: string): Promise<void> {
    const schedule = this.repository.listSchedules().find((item) => item.id === scheduleId);

    if (!schedule || !schedule.enabled) {
      return;
    }

    await this.executeAgentCreate({
      prompt: schedule.prompt,
      conversationId: null
    });

    const lastRunAt = nowIso();
    const nextRunAt =
      schedule.kind === 'interval' && schedule.intervalSeconds
        ? new Date(Date.now() + schedule.intervalSeconds * 1000).toISOString()
        : null;
    this.repository.updateSchedule({
      scheduleId: schedule.id,
      enabled: schedule.kind === 'interval',
      lastRunAt,
      nextRunAt
    });

    if (nextRunAt) {
      const nextSchedule = this.repository.listSchedules().find((item) => item.id === schedule.id);

      if (nextSchedule) {
        this.armSchedule(nextSchedule);
      }
    } else {
      this.scheduleHandles.delete(schedule.id);
    }
  }
}
