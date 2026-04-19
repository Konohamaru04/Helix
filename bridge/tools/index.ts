import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tiff', 'tif', 'avif',
  // Audio/Video
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flac', 'ogg', 'wma', 'wmv', 'webm', 'm4a', 'm4v',
  // Archives
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'zst', 'tgz',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Executables / Compiled
  'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'class', 'jar', 'war',
  'pyc', 'pyo', 'wasm',
  // Database
  'sqlite', 'sqlite3', 'db', 'mdb',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Other binary
  'iso', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'app', 'msi',
]);

export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return BINARY_EXTENSIONS.has(ext);
}
import type { CapabilityService } from '@bridge/capabilities';
import type { ChatRepository } from '@bridge/chat/repository';
import type { CapabilityTask, ContextSource, PlanState, ToolDefinition, ToolInvocation } from '@bridge/ipc/contracts';
import { extractPromptPathCandidate, looksLikeStructuredPath } from '@bridge/path-prompt';
import { resolveBareFilename, IGNORED_DIRECTORY_NAMES } from '@bridge/workspace-resolve';
import {
  contextSourceSchema,
  toolDefinitionSchema,
  toolInvocationSchema
} from '@bridge/ipc/contracts';
import type { OllamaToolDefinition } from '@bridge/ollama/client';
import type { RagService } from '@bridge/rag';
import { runCodeSnippet } from '@bridge/tools/code-runner';
import { searchWeb, type WebSearchResult } from '@bridge/tools/web-search';

const MAX_FILE_READER_BYTES = 256_000;
const MAX_FILE_READER_CHARACTERS = 12_000;
const MAX_WORKSPACE_SEARCH_FILES = 400;
const MAX_WORKSPACE_SEARCH_RESULTS = 8;
const MAX_WORKSPACE_SEARCH_BYTES = 160_000;
const MAX_WORKSPACE_SEARCH_EXCERPT = 220;
const MAX_WORKSPACE_ROOT_SNAPSHOT_ENTRIES = 12;
const MAX_WORKSPACE_OPEN_SEARCH_ENTRIES = 500;
const KNOWLEDGE_SEARCH_RESULT_LIMIT = 5;
const WEB_SEARCH_RESULT_LIMIT = 5;
const CALCULATOR_PATTERN = /^[0-9+\-*/().,%\s]+$/;
const DANGEROUS_OPEN_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.exe',
  '.jar',
  '.js',
  '.lnk',
  '.msi',
  '.ps1',
  '.reg',
  '.scr',
  '.sh',
  '.url',
  '.vbs'
]);
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
  '.yml'
]);

function nowIso() {
  return new Date().toISOString();
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath).toLowerCase();
  const normalizedDirectory = path.resolve(directoryPath).toLowerCase();

  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`)
  );
}

function createInvocation(input: Omit<ToolInvocation, 'id' | 'createdAt' | 'updatedAt'>) {
  const timestamp = nowIso();

  return toolInvocationSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function attachDetailedToolOutput(result: ToolExecutionResult): ToolExecutionResult {
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

function evaluateArithmeticExpression(expression: string): number {
  let index = 0;

  const skipWhitespace = () => {
    while (/\s/.test(expression[index] ?? '')) {
      index += 1;
    }
  };

  const parseNumber = (): number => {
    skipWhitespace();
    const match = expression.slice(index).match(/^\d+(?:\.\d+)?/);

    if (!match?.[0]) {
      throw new Error('Expected a number.');
    }

    index += match[0].length;
    return Number(match[0]);
  };

  const parseFactor = (): number => {
    skipWhitespace();
    const current = expression[index];

    if (current === '+') {
      index += 1;
      return parseFactor();
    }

    if (current === '-') {
      index += 1;
      return -parseFactor();
    }

    if (current === '(') {
      index += 1;
      const value = parseExpression();
      skipWhitespace();

      if (expression[index] !== ')') {
        throw new Error('Expected a closing parenthesis.');
      }

      index += 1;
      return value;
    }

    return parseNumber();
  };

  const parseTerm = (): number => {
    let value = parseFactor();

    while (true) {
      skipWhitespace();
      const operator = expression[index];

      if (operator !== '*' && operator !== '/' && operator !== '%') {
        return value;
      }

      index += 1;
      const right = parseFactor();

      if (operator === '*') {
        value *= right;
      } else if (operator === '/') {
        value /= right;
      } else {
        value %= right;
      }
    }
  };

  const parseExpression = (): number => {
    let value = parseTerm();

    while (true) {
      skipWhitespace();
      const operator = expression[index];

      if (operator !== '+' && operator !== '-') {
        return value;
      }

      index += 1;
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
  };

  const value = parseExpression();
  skipWhitespace();

  if (index !== expression.length) {
    throw new Error('Unexpected input after the end of the expression.');
  }

  return value;
}

function extractCalculatorExpression(prompt: string): string {
  return prompt
    .trim()
    .replace(/[\u00d7]/g, '*')
    .replace(/[\u00f7]/g, '/')
    .replace(/\b(multiplied by|times)\b/gi, '*')
    .replace(/\b(divided by|over)\b/gi, '/')
    .replace(/\b(modulo|mod)\b/gi, '%')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/(?<=\d)\s*[xX]\s*(?=\d)/g, ' * ')
    .replace(/^(what(?:'s| is)?|calculate|compute|evaluate|solve)\s+/i, '')
    .replace(/\s+(?:and|then)\s+(?:explain|show|tell|describe|give).*$|[?!=,:;]+$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQuotedOrRawInput(prompt: string): string | null {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return null;
  }

  // Full-string quote wrap — highest confidence.
  const quotedMatch = trimmedPrompt.match(/^"(.*)"$/s) ?? trimmedPrompt.match(/^'(.*)'$/s);
  if (quotedMatch?.[1] !== undefined) {
    return quotedMatch[1].trim() || null;
  }

  // No spaces or contains path separators → treat as a plain path.
  if (!trimmedPrompt.includes(' ') || /[/\\]/.test(trimmedPrompt)) {
    return trimmedPrompt;
  }

  // Sentence-like input (e.g. model echoed the user message as the arg).
  // Extract the first inline-quoted token if present.
  const inlineQuoted = trimmedPrompt.match(/["']([^"']+)["']/);
  if (inlineQuoted?.[1]) {
    return inlineQuoted[1].trim() || null;
  }

  return trimmedPrompt;
}

function isWorkspaceRootAlias(value: string): boolean {
  return /^(?:\.|\/|\\|here|this|current|root|workspace|workspace root|project root|current (?:dir|directory)|this (?:dir|directory)|current folder|this folder)$/i.test(
    value.trim()
  );
}

function looksLikeWorkspaceListIntent(prompt: string): boolean {
  return (
    /\b(list|show|display|browse|inspect|print|what(?:'s| is)|contents?)\b/i.test(prompt) &&
    /\b(files?|folders?|directories?|items?|tree|structure|project|repo|repository|workspace|directory|folder|root)\b/i.test(
      prompt
    )
  );
}

function looksLikeRepositoryAnalysisRequest(prompt: string): boolean {
  return (
    /\b(analy[sz]e|summari[sz]e|document|describe|explain|understand|map)\b/i.test(prompt) &&
    /\b(repo|repository|codebase|project|implementation|architecture|markup)\b/i.test(prompt)
  );
}

function looksLikePathToken(value: string): boolean {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return false;
  }

  return (
    /^[A-Za-z]:[\\/]/.test(trimmedValue) ||
    /^\.{1,2}(?:[\\/]|$)/.test(trimmedValue) ||
    /^[\\/]/.test(trimmedValue) ||
    /^~[\\/]/.test(trimmedValue) ||
    /[\\/]/.test(trimmedValue) ||
    (!/\s/.test(trimmedValue) && /^[A-Za-z0-9_.-]+$/.test(trimmedValue))
    );
}

function extractInlinePathCandidate(prompt: string): string | null {
  const pathMatch = prompt.match(
    /(?:"([^"]+)"|'([^']+)'|([A-Za-z]:[^"`\s,;?!]+|\.{1,2}(?:[\\/][^"`\s,;?!]+)+|~?(?:[\\/][^"`\s,;?!]+)+|[A-Za-z0-9_.' -]+(?:[\\/][A-Za-z0-9_.' -]+)+|\.?[A-Za-z0-9_' -]+(?:\.[A-Za-z0-9_' -]+)+))/i
  );

  return (pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3] ?? null)?.trim() || null;
}

function extractWorkspaceListPath(prompt: string): string {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return '.';
  }

  const directInput = parseQuotedOrRawInput(trimmedPrompt);

  if (!directInput) {
    return '.';
  }

  if (isWorkspaceRootAlias(directInput)) {
    return '.';
  }

  const inlinePathCandidate = extractInlinePathCandidate(trimmedPrompt);

  if (
    inlinePathCandidate &&
    /\b(correct|right|actual(?:ly)?|meant|instead|directory|folder|path|root)\b/i.test(
      trimmedPrompt
    )
  ) {
    return isWorkspaceRootAlias(inlinePathCandidate) ? '.' : inlinePathCandidate;
  }

  if (looksLikePathToken(directInput) && !looksLikeWorkspaceListIntent(directInput)) {
    return directInput;
  }

  // Repository-summary prompts should inspect the connected workspace root unless an
  // explicit path was provided. Otherwise natural-language phrases like "of the
  // implementation" can be mistaken for relative paths such as "the".
  if (looksLikeRepositoryAnalysisRequest(trimmedPrompt) && !inlinePathCandidate) {
    return '.';
  }

  if (
    /\b(?:in|inside|under|within|from|of)\s+(?:the\s+)?(?:(?:current|this)\s+(?:workspace|project\s+)?(?:dir(?:ectory)?|folder|root)|(?:workspace|project)\s+root)\b/i.test(
      trimmedPrompt
    )
  ) {
    return '.';
  }

  const prepositionMatch = trimmedPrompt.match(
    /(?:in|inside|under|within|from|of)\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z]:[^"'`?!,;]+|\.{1,2}(?:[\\/][^"'`?!,;]+)*|~?(?:[\\/][^"'`?!,;]+)+|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*))/i
  );
  const extractedPath =
    prepositionMatch?.[1] ?? prepositionMatch?.[2] ?? prepositionMatch?.[3] ?? null;
  const shouldTreatPrepositionAsPath =
    looksLikeWorkspaceListIntent(trimmedPrompt) ||
    /\b(directory|folder|path|root)\b/i.test(trimmedPrompt) ||
    inlinePathCandidate !== null;

  if (extractedPath && shouldTreatPrepositionAsPath) {
    const normalizedPath = extractedPath.trim();
    return isWorkspaceRootAlias(normalizedPath) ? '.' : normalizedPath;
  }

  return '.';
}

function sanitizeWorkspaceOpenPrompt(prompt: string): string {
  return prompt
    .trim()
    .replace(
      /^(?:please\s+)?(?:open|play|launch|start|watch|preview|reveal|show)(?:\s+up)?\s+/i,
      ''
    )
    .replace(
      /^(?:the\s+)?(?:file|folder|directory|video|audio|song|music|image|photo|picture|document|pdf)\s+/i,
      ''
    )
    .replace(/\s+(?:for me|please)\s*$/i, '')
    .trim();
}

function extractWorkspaceOpenPath(prompt: string): string | null {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return null;
  }

  const normalizedPrompt = sanitizeWorkspaceOpenPrompt(trimmedPrompt);
  const directInput =
    parseQuotedOrRawInput(normalizedPrompt) ?? parseQuotedOrRawInput(trimmedPrompt);

  if (!directInput) {
    return null;
  }

  if (isWorkspaceRootAlias(directInput)) {
    return '.';
  }

  const inlinePathCandidate =
    extractInlinePathCandidate(normalizedPrompt) ?? extractInlinePathCandidate(trimmedPrompt);

  if (inlinePathCandidate) {
    return isWorkspaceRootAlias(inlinePathCandidate) ? '.' : inlinePathCandidate;
  }

  return directInput;
}

function extractWebSearchQuery(prompt: string): string {
  return prompt
    .trim()
    .replace(
      /^(?:please\s+)?(?:search|look\s+up|find|check|search\s+the\s+web|look\s+online)(?:\s+(?:the\s+)?web|online)?\s+(?:for\s+)?/i,
      ''
    )
    .trim();
}

function normalizeSearchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function includesAllTokens(haystack: string, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function isLikelyTextFile(filePath: string): boolean {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function buildSearchExcerpt(
  contents: string,
  queryLower: string,
  queryTokens: string[]
): string {
  const normalizedContents = contents.replace(/\r\n/g, '\n');
  const lowerContents = normalizedContents.toLowerCase();
  let matchIndex = queryLower ? lowerContents.indexOf(queryLower) : -1;

  if (matchIndex === -1) {
    matchIndex = queryTokens.reduce((bestIndex, token) => {
      if (bestIndex !== -1) {
        return bestIndex;
      }

      return lowerContents.indexOf(token);
    }, -1);
  }

  if (matchIndex === -1) {
    return normalizedContents.slice(0, MAX_WORKSPACE_SEARCH_EXCERPT).trim();
  }

  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(normalizedContents.length, matchIndex + MAX_WORKSPACE_SEARCH_EXCERPT);
  const excerpt = normalizedContents.slice(start, end).trim();
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < normalizedContents.length ? ' ...' : '';

  return `${prefix}${excerpt}${suffix}`;
}

function buildWorkspaceDirectorySnapshot(
  entries: Array<{ name: string; isDirectory(): boolean }>,
  limit: number
) {
  const sortedEntries = [...entries].sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
  const limitedEntries = sortedEntries.slice(0, limit);
  const renderedEntries =
    limitedEntries.length > 0
      ? limitedEntries.map((entry) => `- ${entry.name}${entry.isDirectory() ? '/' : ''}`)
      : ['- No files or folders found.'];

  return {
    renderedEntries,
    excerpt: renderedEntries.join('\n'),
    totalEntries: sortedEntries.length,
    truncated: sortedEntries.length > limitedEntries.length
  };
}

const MAX_RECURSIVE_LIST_ENTRIES = 2000;

async function buildRecursiveDirectorySnapshot(
  dirPath: string,
  limit: number
): Promise<{ lines: string[]; flatPaths: string[]; totalFiles: number; totalDirs: number; truncated: boolean }> {
  const lines: string[] = [];
  const flatPaths: string[] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let truncated = false;

  async function walk(currentPath: string, treePrefix: string, relPrefix: string): Promise<void> {
    if (truncated) return;

    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < sorted.length; i++) {
      if (lines.length >= limit) {
        truncated = true;
        return;
      }
      const entry = sorted[i]!;
      const isLast = i === sorted.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = treePrefix + (isLast ? '    ' : '│   ');
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        totalDirs++;
        lines.push(`${treePrefix}${connector}${entry.name}/`);
        flatPaths.push(`${relPath}/`);
        if (IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
        await walk(path.join(currentPath, entry.name), childPrefix, relPath);
      } else {
        totalFiles++;
        lines.push(`${treePrefix}${connector}${entry.name}`);
        flatPaths.push(relPath);
      }
    }
  }

  await walk(dirPath, '', '');
  return { lines, flatPaths, totalFiles, totalDirs, truncated };
}

async function readSearchableTextFile(filePath: string): Promise<string | null> {
  if (isBinaryExtension(filePath)) {
    return null;
  }

  const fileStat = await stat(filePath);

  if (!fileStat.isFile() || fileStat.size > MAX_WORKSPACE_SEARCH_BYTES) {
    return null;
  }

  const buffer = await readFile(filePath);

  if (buffer.includes(0)) {
    return null;
  }

  return buffer.toString('utf8');
}

function resolveWorkspacePath(candidatePath: string, workspaceRootPath: string): string {
  const resolvedPath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRootPath, candidatePath);

  if (!isWithinDirectory(resolvedPath, workspaceRootPath)) {
    throw new Error(
      'This tool can only access paths inside the connected workspace folder.'
    );
  }

  return resolvedPath;
}

const builtinTools = [
  toolDefinitionSchema.parse({
    id: 'code-runner',
    title: 'Code Runner',
    description:
      'Run dependency-free JavaScript snippets in a constrained local sandbox.',
    command: '/run'
  }),
  toolDefinitionSchema.parse({
    id: 'calculator',
    title: 'Calculator',
    description: 'Evaluate arithmetic expressions safely.',
    command: '/calc'
  }),
  toolDefinitionSchema.parse({
    id: 'file-reader',
    title: 'File Reader',
    description:
      'Read a text file from the connected workspace folder, imported knowledge, or known attachments.',
    command: '/read'
  }),
  toolDefinitionSchema.parse({
    id: 'workspace-lister',
    title: 'Workspace Lister',
    description: 'List files and folders from the connected workspace directory.',
    command: '/ls'
  }),
  toolDefinitionSchema.parse({
    id: 'workspace-opener',
    title: 'Workspace Opener',
    description:
      'Open a safe file or folder from the connected workspace with the system default app.',
    command: '/open'
  }),
  toolDefinitionSchema.parse({
    id: 'workspace-search',
    title: 'Workspace Search',
    description: 'Search file names and text content inside the connected workspace directory.',
    command: '/grep'
  }),
  toolDefinitionSchema.parse({
    id: 'knowledge-search',
    title: 'Knowledge Search',
    description: 'Search imported workspace knowledge and return grounded source snippets.',
    command: '/knowledge'
  }),
  toolDefinitionSchema.parse({
    id: 'web-search',
    title: 'Web Search',
    description: 'Search the public web and return source-linked result snippets.',
    command: '/web'
  })
];

const NATIVE_OLLAMA_TOOL_IDS = [
  'code-runner',
  'calculator',
  'workspace-lister',
  'workspace-opener',
  'workspace-search',
  'knowledge-search',
  'web-search',
  'ask-user-question',
  'agent',
  'read',
  'glob',
  'grep',
  //'bash',
  'powershell',
  'monitor',
  'write',
  'edit',
  'task-create',
  'task-get',
  'task-list',
  'task-output',
  'task-stop',
  'task-update',
  'todo-write',
  'cron-create',
  'cron-delete',
  'cron-list',
  'enter-plan-mode',
  'exit-plan-mode',
  'enter-worktree',
  'exit-worktree',
  'notebook-edit',
  'lsp',
  'list-mcp-resources',
  'read-mcp-resource',
  'send-message',
  'team-create',
  'team-delete',
  'tool-search',
  'web-fetch',
  'skill'
] as const;

const WORKSPACE_ROOT_REQUIRED_TOOL_IDS = new Set([
  'workspace-lister',
  'workspace-opener',
  'workspace-search'
]);

export interface ToolExecutionResult {
  assistantContent: string;
  toolInvocations: ToolInvocation[];
  contextSources: ContextSource[];
}

interface ToolExecutionInput {
  toolId: string;
  prompt: string;
  workspaceRootPath?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
}

interface WorkspaceSearchMatch {
  sourcePath: string;
  label: string;
  excerpt: string;
}

export type WorkspacePathLauncher = (
  targetPath: string
) => Promise<string | null | undefined>;
export type WebSearcher = (
  query: string,
  limit: number
) => Promise<WebSearchResult[]>;

export class ToolDispatcher {
  constructor(
    private readonly appPath: string,
    private readonly repository: ChatRepository,
    private readonly ragService: RagService,
    private readonly workspacePathLauncher?: WorkspacePathLauncher,
    private readonly webSearcher: WebSearcher = searchWeb,
    private readonly capabilityService?: Pick<
      CapabilityService,
      'listDefinitions' | 'getById' | 'executeTool' | 'getPlanState' | 'listTasks'
    >
  ) {}

  listDefinitions(): ToolDefinition[] {
    const definitions = new Map<string, ToolDefinition>();

    for (const definition of builtinTools) {
      definitions.set(definition.id, definition);
    }

    for (const definition of this.capabilityService?.listDefinitions() ?? []) {
      definitions.set(definition.id, definition);
    }

    return [...definitions.values()];
  }

  getById(toolId: string): ToolDefinition | null {
    return (
      builtinTools.find((tool) => tool.id === toolId) ??
      this.capabilityService?.getById(toolId) ??
      null
    );
  }

  findByCommand(commandToken: string): ToolDefinition | null {
    return this.listDefinitions().find((tool) => tool.command === commandToken) ?? null;
  }

  requiresWorkspaceRoot(toolId: string): boolean {
    return WORKSPACE_ROOT_REQUIRED_TOOL_IDS.has(toolId);
  }

  listOllamaToolDefinitions(options?: {
    workspaceRootPath?: string | null;
  }): OllamaToolDefinition[] {
    const workspaceRootConnected = Boolean(options?.workspaceRootPath);

    return NATIVE_OLLAMA_TOOL_IDS
      .filter(
        (toolId) =>
          workspaceRootConnected || !this.requiresWorkspaceRoot(toolId)
      )
      .filter((toolId) => this.getById(toolId) !== null)
      .map((toolId) => this.buildOllamaToolDefinition(toolId))
      .filter((definition): definition is OllamaToolDefinition => definition !== null);
  }

  getPlanContext(workspaceId: string | null): { planState: PlanState | null; tasks: CapabilityTask[] } {
    if (!this.capabilityService) {
      return { planState: null, tasks: [] };
    }
    return {
      planState: this.capabilityService.getPlanState(workspaceId),
      tasks: this.capabilityService.listTasks(workspaceId)
    };
  }

  async executeOllamaToolCall(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    workspaceRootPath?: string | null;
    workspaceId?: string | null;
    conversationId?: string | null;
  }): Promise<ToolExecutionResult> {
    return this.execute({
      toolId: input.toolName,
      prompt: this.buildOllamaToolPrompt(input.toolName, input.arguments),
      workspaceRootPath: input.workspaceRootPath ?? null,
      workspaceId: input.workspaceId ?? null,
      conversationId: input.conversationId ?? null
    });
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    if (input.toolId === 'code-runner') {
      return attachDetailedToolOutput(await this.executeCodeRunner(input.prompt));
    }

    if (input.toolId === 'calculator') {
      return attachDetailedToolOutput(this.executeCalculator(input.prompt));
    }

    if (input.toolId === 'file-reader') {
      return attachDetailedToolOutput(
        await this.executeFileReader(input.prompt, input.workspaceRootPath ?? null)
      );
    }

    if (input.toolId === 'workspace-lister') {
      return attachDetailedToolOutput(
        await this.executeWorkspaceLister(input.prompt, input.workspaceRootPath ?? null)
      );
    }

    if (input.toolId === 'workspace-opener') {
      return attachDetailedToolOutput(
        await this.executeWorkspaceOpener(input.prompt, input.workspaceRootPath ?? null)
      );
    }

    if (input.toolId === 'workspace-search') {
      return attachDetailedToolOutput(
        await this.executeWorkspaceSearch(input.prompt, input.workspaceRootPath ?? null)
      );
    }

    if (input.toolId === 'knowledge-search') {
      return attachDetailedToolOutput(
        this.executeKnowledgeSearch(input.prompt, input.workspaceId ?? null)
      );
    }

    if (input.toolId === 'web-search') {
      return attachDetailedToolOutput(await this.executeWebSearch(input.prompt));
    }

    if (this.capabilityService) {
      return attachDetailedToolOutput(
        await this.capabilityService.executeTool({
          toolId: input.toolId,
          prompt: input.prompt,
          workspaceRootPath: input.workspaceRootPath ?? null,
          workspaceId: input.workspaceId ?? null,
          conversationId: input.conversationId ?? null
        })
      );
    }

    throw new Error(`Tool ${input.toolId} is not registered.`);
  }

  private buildOllamaToolDefinition(toolId: string): OllamaToolDefinition | null {
    switch (toolId) {
      case 'code-runner':
        return {
          type: 'function',
          function: {
            name: 'code-runner',
            description: 'Run dependency-free JavaScript in a local sandbox.',
            parameters: {
              type: 'object',
              required: ['code'],
              properties: {
                code: {
                  type: 'string',
                  description: 'The JavaScript snippet to run.'
                }
              }
            }
          }
        };
      case 'calculator':
        return {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Evaluate a math expression safely.',
            parameters: {
              type: 'object',
              required: ['expression'],
              properties: {
                expression: {
                  type: 'string',
                  description: 'The arithmetic expression to evaluate.'
                }
              }
            }
          }
        };
      case 'file-reader':
        return {
          type: 'function',
          function: {
            name: 'file-reader',
            description: 'Read a text file from the app or connected workspace.',
            parameters: {
              type: 'object',
              required: ['path'],
              properties: {
                path: {
                  type: 'string',
                  description: 'The file path to read.'
                }
              }
            }
          }
        };
      case 'workspace-lister':
        return {
          type: 'function',
          function: {
            name: 'workspace-lister',
            description: 'List files and folders from the connected workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Optional directory path inside the workspace. Defaults to the workspace root.'
                }
              }
            }
          }
        };
      case 'workspace-opener':
        return {
          type: 'function',
          function: {
            name: 'workspace-opener',
            description: 'Open a safe file or folder from the connected workspace.',
            parameters: {
              type: 'object',
              required: ['path'],
              properties: {
                path: {
                  type: 'string',
                  description: 'The workspace file or folder to open.'
                }
              }
            }
          }
        };
      case 'workspace-search':
        return {
          type: 'function',
          function: {
            name: 'workspace-search',
            description: 'Search file names and text content inside the connected workspace.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'The filename or text query to search for.'
                }
              }
            }
          }
        };
      case 'knowledge-search':
        return {
          type: 'function',
          function: {
            name: 'knowledge-search',
            description: 'Search imported workspace knowledge and return grounded sources.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'The knowledge search query.'
                }
              }
            }
          }
        };
      case 'web-search':
        return {
          type: 'function',
          function: {
            name: 'web-search',
            description: 'Search the public web and return linked snippets.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'The web search query.'
                }
              }
            }
          }
        };
      case 'ask-user-question':
        return {
          type: 'function',
          function: {
            name: 'ask-user-question',
            description:
              'Ask a structured multiple-choice clarification question before continuing.',
            parameters: {
              type: 'object',
              required: ['question', 'options'],
              properties: {
                question: {
                  type: 'string',
                  description: 'The clarification question to ask.'
                },
                options: {
                  type: 'array',
                  description: 'The candidate choices to present to the user.',
                  items: {
                    type: 'string'
                  }
                }
              }
            }
          }
        };
      case 'agent':
        return {
          type: 'function',
          function: {
            name: 'agent',
            description: 'Launch a background agent for complex reasoning or multi-step subtasks. Returns results asynchronously.',
            parameters: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt: {
                  type: 'string',
                  description: 'The task or prompt for the agent session.'
                }
              }
            }
          }
        };
      case 'read':
        return {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a text file from the app workspace or connected workspace. For directories, use workspace-lister instead.',
            parameters: {
              type: 'object',
              required: ['filePath'],
              properties: {
                filePath: {
                  type: 'string',
                  description: 'The file path to read.'
                }
              }
            }
          }
        };
      case 'glob':
        return {
          type: 'function',
          function: {
            name: 'glob',
            description: 'Find workspace files that match a glob pattern.',
            parameters: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'The glob pattern to match. Defaults to **/*.'
                }
              }
            }
          }
        };
      case 'grep':
        return {
          type: 'function',
          function: {
            name: 'grep',
            description: 'Search plain text inside workspace files.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'The plain-text query to search for.'
                }
              }
            }
          }
        };
      case 'bash':
      case 'powershell':
        return {
          type: 'function',
          function: {
            name: toolId,
            description:
              toolId === 'bash'
                ? 'Run a bash command with captured output.'
                : 'Run a PowerShell command with captured output.',
            parameters: {
              type: 'object',
              required: ['command'],
              properties: {
                command: {
                  type: 'string',
                  description: 'The shell command to execute.'
                }
              }
            }
          }
        };
      case 'monitor':
        return {
          type: 'function',
          function: {
            name: 'monitor',
            description: 'Run a long-lived command (build, test, server) in the background. Output captured in a tracked task.',
            parameters: {
              type: 'object',
              required: ['command'],
              properties: {
                command: {
                  type: 'string',
                  description: 'The shell command to monitor in the background.'
                }
              }
            }
          }
        };
      case 'write':
        return {
          type: 'function',
          function: {
            name: 'write',
            description:
              'Create or overwrite a text file inside the allowed workspace boundary. Pass JSON with filePath or path plus content.',
            parameters: {
              type: 'object',
              required: ['content'],
              properties: {
                filePath: {
                  type: 'string',
                  description: 'The file path to write.'
                },
                path: {
                  type: 'string',
                  description: 'Alias for filePath.'
                },
                content: {
                  type: 'string',
                  description: 'The full file contents to write.'
                }
              }
            }
          }
        };
      case 'edit':
        return {
          type: 'function',
          function: {
            name: 'edit',
            description:
              'Edit a local file by line number. ' +
              'Replace: { filePath, startLine, endLine, newText } — replaces lines startLine..endLine (1-based, inclusive) with newText. ' +
              'Insert: { filePath, line, operation: "insert_after", newText } — inserts newText after line (use 0 to prepend). ' +
              'Always read the file first to get exact line numbers. For changes spanning most of the file use write instead.',
            parameters: {
              type: 'object',
              required: ['filePath'],
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the file to edit.'
                },
                path: {
                  type: 'string',
                  description: 'Alias for filePath.'
                },
                startLine: {
                  type: 'integer',
                  description: '1-based line number where replacement begins (inclusive). Required for replace.'
                },
                endLine: {
                  type: 'integer',
                  description: '1-based line number where replacement ends (inclusive). Required for replace.'
                },
                line: {
                  type: 'integer',
                  description: '1-based line number for insert_after. Use 0 to insert at the beginning of the file.'
                },
                operation: {
                  type: 'string',
                  enum: ['replace', 'insert_after'],
                  description: 'Operation type. Defaults to "replace" when startLine/endLine are provided.'
                },
                newText: {
                  type: 'string',
                  description: 'Replacement or insertion text. Do not add a trailing newline — the tool handles line endings.'
                }
              }
            }
          }
        };
      case 'task-create':
        return {
          type: 'function',
          function: {
            name: 'task-create',
            description: 'Create a tracked task for a distinct unit of work. Each task has status: pending, in_progress, completed, cancelled, or failed.',
            parameters: {
              type: 'object',
              required: ['title'],
              properties: {
                title: {
                  type: 'string',
                  description: 'The task title.'
                },
                details: {
                  type: 'string',
                  description: 'Optional task details.'
                }
              }
            }
          }
        };
      case 'task-get':
        return {
          type: 'function',
          function: {
            name: 'task-get',
            description: 'Fetch a tracked task by id.',
            parameters: {
              type: 'object',
              required: ['taskId'],
              properties: {
                taskId: {
                  type: 'string',
                  description: 'The task id to load.'
                }
              }
            }
          }
        };
      case 'task-list':
        return {
          type: 'function',
          function: {
            name: 'task-list',
            description: 'List tracked tasks.',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        };
      case 'task-output':
        return {
          type: 'function',
          function: {
            name: 'task-output',
            description: 'Read the output file for a tracked task.',
            parameters: {
              type: 'object',
              required: ['taskId'],
              properties: {
                taskId: {
                  type: 'string',
                  description: 'The task id whose output should be read.'
                }
              }
            }
          }
        };
      case 'task-stop':
        return {
          type: 'function',
          function: {
            name: 'task-stop',
            description: 'Cancel a task that is no longer needed.',
            parameters: {
              type: 'object',
              required: ['taskId'],
              properties: {
                taskId: {
                  type: 'string',
                  description: 'The task id to stop.'
                }
              }
            }
          }
        };
      case 'task-update':
        return {
          type: 'function',
          function: {
            name: 'task-update',
            description: 'Update task status: set "in_progress" when starting work, "completed" when done, "cancelled" if unnecessary, or "failed" if blocked.',
            parameters: {
              type: 'object',
              required: ['taskId'],
              properties: {
                taskId: {
                  type: 'string',
                  description: 'The task id to update.'
                },
                title: {
                  type: 'string',
                  description: 'Optional updated task title.'
                },
                details: {
                  type: 'string',
                  description: 'Optional updated task details.'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled', 'failed'],
                  description: 'Optional next task status.'
                },
                outputPath: {
                  type: 'string',
                  description: 'Optional output file path for the task.'
                }
              }
            }
          }
        };
      case 'todo-write':
        return {
          type: 'function',
          function: {
            name: 'todo-write',
            description: 'Create multiple tracked tasks from a checklist or item list.',
            parameters: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  description: 'The checklist items to create as tasks.',
                  items: {
                    type: 'string'
                  }
                }
              }
            }
          }
        };
      case 'cron-create':
        return {
          type: 'function',
          function: {
            name: 'cron-create',
            description: "Schedule a prompt to run once at a specific time or on a recurring interval. Kind must be 'once' or 'interval'.",
            parameters: {
              type: 'object',
              required: ['title', 'prompt', 'kind'],
              properties: {
                title: {
                  type: 'string',
                  description: 'The human-readable schedule title.'
                },
                prompt: {
                  type: 'string',
                  description: 'The prompt to run when the schedule fires.'
                },
                kind: {
                  type: 'string',
                  enum: ['once', 'interval'],
                  description: 'Whether the schedule runs once or on an interval.'
                },
                intervalSeconds: {
                  type: 'number',
                  description: 'Required for interval schedules.'
                },
                runAt: {
                  type: 'string',
                  description: 'Required for one-shot schedules as an ISO timestamp.'
                }
              }
            }
          }
        };
      case 'cron-delete':
        return {
          type: 'function',
          function: {
            name: 'cron-delete',
            description: 'Delete a scheduled prompt by id.',
            parameters: {
              type: 'object',
              required: ['scheduleId'],
              properties: {
                scheduleId: {
                  type: 'string',
                  description: 'The schedule id to delete.'
                }
              }
            }
          }
        };
      case 'cron-list':
        return {
          type: 'function',
          function: {
            name: 'cron-list',
            description: 'List all scheduled prompts and their next run times.',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        };
      case 'enter-plan-mode':
        return {
          type: 'function',
          function: {
            name: 'enter-plan-mode',
            description: 'Activate structured plan mode for multi-step tasks. Call before starting complex work that benefits from tracking subtasks.',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        };
      case 'exit-plan-mode':
        return {
          type: 'function',
          function: {
            name: 'exit-plan-mode',
            description: 'Deactivate plan mode after all tasks are complete. Pass a summary of accomplishments.',
            parameters: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: 'Optional summary of the final plan.'
                }
              }
            }
          }
        };
      case 'enter-worktree':
        return {
          type: 'function',
          function: {
            name: 'enter-worktree',
            description: 'Create an isolated git worktree for parallel development on a separate branch.',
            parameters: {
              type: 'object',
              required: ['repoRoot', 'branch'],
              properties: {
                repoRoot: {
                  type: 'string',
                  description: 'The repository root to create the worktree from.'
                },
                branch: {
                  type: 'string',
                  description: 'The branch name for the worktree.'
                }
              }
            }
          }
        };
      case 'exit-worktree':
        return {
          type: 'function',
          function: {
            name: 'exit-worktree',
            description: 'Leave and clean up a worktree session when work there is done.',
            parameters: {
              type: 'object',
              required: ['sessionId'],
              properties: {
                sessionId: {
                  type: 'string',
                  description: 'The worktree session id to close.'
                }
              }
            }
          }
        };
      case 'notebook-edit':
        return {
          type: 'function',
          function: {
            name: 'notebook-edit',
            description: 'Replace a Jupyter notebook cell source by index.',
            parameters: {
              type: 'object',
              required: ['filePath', 'cellIndex', 'source'],
              properties: {
                filePath: {
                  type: 'string',
                  description: 'The notebook file path.'
                },
                cellIndex: {
                  type: 'number',
                  description: 'The zero-based cell index to update.'
                },
                source: {
                  type: 'string',
                  description: 'The full replacement cell source.'
                }
              }
            }
          }
        };
      case 'lsp':
        return {
          type: 'function',
          function: {
            name: 'lsp',
            description: "Code intelligence: use action='definition' to find definitions, 'references' for usages, 'diagnostics' for errors.",
            parameters: {
              type: 'object',
              required: ['action'],
              properties: {
                action: {
                  type: 'string',
                  enum: ['definition', 'references', 'diagnostics'],
                  description: 'The LSP action to run.'
                },
                symbol: {
                  type: 'string',
                  description: 'The symbol to inspect for definition or references.'
                }
              }
            }
          }
        };
      case 'list-mcp-resources':
        return {
          type: 'function',
          function: {
            name: 'list-mcp-resources',
            description: 'List readable resources exposed by the local MCP surface.',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        };
      case 'read-mcp-resource':
        return {
          type: 'function',
          function: {
            name: 'read-mcp-resource',
            description: 'Read one MCP resource by label or local source path.',
            parameters: {
              type: 'object',
              required: ['resource'],
              properties: {
                resource: {
                  type: 'string',
                  description: 'The resource label or source path to read.'
                }
              }
            }
          }
        };
      case 'send-message':
        return {
          type: 'function',
          function: {
            name: 'send-message',
            description: 'Continue an agent session with additional instructions.',
            parameters: {
              type: 'object',
              required: ['sessionId', 'message'],
              properties: {
                sessionId: {
                  type: 'string',
                  description: 'The agent session id to continue.'
                },
                message: {
                  type: 'string',
                  description: 'The message to send to the agent session.'
                }
              }
            }
          }
        };
      case 'team-create':
        return {
          type: 'function',
          function: {
            name: 'team-create',
            description: 'Create a team of agents working in parallel, each with its own prompt.',
            parameters: {
              type: 'object',
              required: ['title', 'agentPrompts'],
              properties: {
                title: {
                  type: 'string',
                  description: 'The team title.'
                },
                agentPrompts: {
                  type: 'array',
                  description: 'The initial prompts for the team member agents.',
                  items: {
                    type: 'string'
                  }
                }
              }
            }
          }
        };
      case 'team-delete':
        return {
          type: 'function',
          function: {
            name: 'team-delete',
            description: 'Archive and clean up a completed team.',
            parameters: {
              type: 'object',
              required: ['teamId'],
              properties: {
                teamId: {
                  type: 'string',
                  description: 'The team id to archive.'
                }
              }
            }
          }
        };
      case 'tool-search':
        return {
          type: 'function',
          function: {
            name: 'tool-search',
            description: 'Discover available tools and skills by keyword. Use when unsure which tool applies.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'The tool or capability query.'
                }
              }
            }
          }
        };
      case 'web-fetch':
        return {
          type: 'function',
          function: {
            name: 'web-fetch',
            description: 'Fetch a remote URL and return a bounded text excerpt.',
            parameters: {
              type: 'object',
              required: ['url'],
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to fetch.'
                }
              }
            }
          }
        };
      case 'skill':
        return {
          type: 'function',
          function: {
            name: 'skill',
            description: 'Invoke a registered skill by ID. Pass an optional prompt to customize behavior.',
            parameters: {
              type: 'object',
              required: ['skillId'],
              properties: {
                skillId: {
                  type: 'string',
                  description: 'The skill id to inspect or invoke.'
                },
                prompt: {
                  type: 'string',
                  description: 'Optional user request to combine with the skill prompt.'
                }
              }
            }
          }
        };
      default:
        return null;
    }
  }

  private buildOllamaToolPrompt(
    toolId: string,
    args: Record<string, unknown>
  ): string {
    const rawInput = getRawToolArg(args);

    switch (toolId) {
      case 'code-runner':
        return rawInput ?? getStringArg(args, 'code', 'snippet');
      case 'calculator':
        return rawInput ?? getStringArg(args, 'expression');
      case 'file-reader':
      case 'workspace-opener':
      case 'read':
        return rawInput ?? getStringArg(args, 'path', 'filePath');
      case 'workspace-lister':
      case 'glob':
        return rawInput ?? (getStringArg(args, 'pattern', 'path') || '.');
      case 'workspace-search':
      case 'grep':
      case 'knowledge-search':
      case 'web-search':
      case 'tool-search':
        return rawInput ?? getStringArg(args, 'query');
      case 'ask-user-question':
        return rawInput ?? JSON.stringify(args);
      case 'bash':
      case 'powershell':
      case 'monitor':
        return rawInput ?? getStringArg(args, 'command');
      case 'write':
      case 'edit':
      case 'task-create':
      case 'task-update':
      case 'cron-create':
      case 'send-message':
      case 'team-create':
      case 'notebook-edit':
        return rawInput ?? JSON.stringify(args);
      case 'todo-write': {
        const items = Array.isArray(args.items)
          ? args.items
              .map((item) =>
                typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
                  ? `${item}`.trim()
                  : ''
              )
              .filter(Boolean)
          : [];

        return items.length > 0 ? JSON.stringify({ items }) : JSON.stringify(args);
      }
      case 'skill': {
        const skillId = getStringArg(args, 'skillId', 'id').replace(/^@/, '').trim();
        const skillPrompt = getStringArg(args, 'prompt', 'request').trim();

        if (!skillId) {
          return rawInput ?? JSON.stringify(args);
        }

        return skillPrompt ? `${skillId} :: ${skillPrompt}` : skillId;
      }
      case 'task-get':
      case 'task-output':
      case 'task-stop':
      case 'cron-delete':
      case 'team-delete':
      case 'exit-worktree':
      case 'read-mcp-resource':
        return getStringArg(
          args,
          'taskId',
          'scheduleId',
          'teamId',
          'sessionId',
          'resource'
        );
      case 'task-list':
      case 'cron-list':
      case 'list-mcp-resources':
      case 'enter-plan-mode':
        return '';
      case 'lsp':
        return rawInput ?? JSON.stringify({
          action: args.action ?? '',
          ...(typeof args.symbol === 'string' && args.symbol.trim()
            ? { symbol: args.symbol }
            : {})
        });
      case 'web-fetch':
        return rawInput ?? getStringArg(args, 'url');
      case 'enter-worktree':
        return rawInput ?? JSON.stringify({
          repoRoot: args.repoRoot ?? '',
          branch: args.branch ?? ''
        });
      case 'exit-plan-mode':
        return rawInput ?? getStringArg(args, 'summary');
      case 'agent':
        return rawInput ?? getStringArg(args, 'prompt');
      default:
        return rawInput ?? JSON.stringify(args);
    }
  }

  private async executeCodeRunner(prompt: string): Promise<ToolExecutionResult> {
    const result = await runCodeSnippet(prompt);
    const renderedSections = ['### Code Runner', '', 'Executed a sandboxed JavaScript snippet.'];

    if (result.stdout) {
      renderedSections.push('', 'Stdout', '', '```text', result.stdout, '```');
    }

    if (result.stderr) {
      renderedSections.push('', 'Stderr', '', '```text', result.stderr, '```');
    }

    if (result.result) {
      renderedSections.push('', 'Result', '', '```text', result.result, '```');
    }

    renderedSections.push(
      '',
      `Runtime: ${result.durationMs} ms${result.timedOut ? ' (timed out)' : ''}`
    );

    return {
      assistantContent: renderedSections.join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'code-runner',
          displayName: 'Code Runner',
          status: 'completed',
          inputSummary: 'dependency-free JavaScript snippet',
          outputSummary: summarizeToolOutput(
            [result.stdout, result.stderr, result.result].filter(Boolean).join('\n')
          ),
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private executeCalculator(prompt: string): ToolExecutionResult {
    const expression = extractCalculatorExpression(prompt);

    if (!expression) {
      throw new Error('Provide an expression after /calc.');
    }

    if (!CALCULATOR_PATTERN.test(expression)) {
      throw new Error(
        'The calculator only accepts digits, parentheses, decimals, and basic operators.'
      );
    }

    let result: number;

    try {
      result = evaluateArithmeticExpression(expression);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to evaluate expression: ${error.message}`
          : 'Unable to evaluate expression.'
      );
    }

    if (!Number.isFinite(result)) {
      throw new Error('The calculator result was not finite.');
    }

    const output = `${result}`;

    return {
      assistantContent: `### Calculator\n\n\`${expression}\` = **${output}**`,
      toolInvocations: [
        createInvocation({
          toolId: 'calculator',
          displayName: 'Calculator',
          status: 'completed',
          inputSummary: expression,
          outputSummary: output,
          errorMessage: null
        })
      ],
      contextSources: []
    };
  }

  private async resolveFilePath(
    candidatePath: string,
    workspaceRootPath: string
  ): Promise<string> {
    const resolvedPath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(workspaceRootPath, candidatePath);

    try {
      const fileStat = await stat(resolvedPath);
      if (fileStat.isFile()) return resolvedPath;
    } catch {
      // File doesn't exist at resolved path — try fuzzy resolution below
    }

    if (looksLikeStructuredPath(candidatePath) || /[\\/]/.test(candidatePath)) {
      return resolvedPath;
    }

    const alternative = await resolveBareFilename(candidatePath, workspaceRootPath);

    if (!alternative) return resolvedPath;

    const readablePath =
      isWithinDirectory(alternative, this.appPath) ||
      isWithinDirectory(alternative, workspaceRootPath) ||
      this.repository.hasAttachmentPath(alternative) ||
      this.ragService.hasDocumentPath(alternative);

    if (readablePath) return alternative;

    return resolvedPath;
  }

  private async executeFileReader(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<ToolExecutionResult> {
    let jsonPath: string | undefined;
    try {
      const parsed = JSON.parse(prompt);
      if (typeof parsed === 'object' && parsed !== null) {
        jsonPath = (parsed.filePath ?? parsed.path)?.trim();
      }
    } catch { /* not JSON, fall through */ }
    const candidatePath = jsonPath || extractPromptPathCandidate(prompt);

    if (!candidatePath) {
      throw new Error('Provide a file path to read.');
    }

    if (!path.isAbsolute(candidatePath) && !workspaceRootPath) {
      throw new Error(
        'Connect a workspace folder before reading relative paths with the file reader.'
      );
    }

    const resolvedPath = workspaceRootPath
      ? await this.resolveFilePath(candidatePath, workspaceRootPath)
      : path.resolve(candidatePath);
    const readablePath =
      isWithinDirectory(resolvedPath, this.appPath) ||
      Boolean(workspaceRootPath && isWithinDirectory(resolvedPath, workspaceRootPath)) ||
      this.repository.hasAttachmentPath(resolvedPath) ||
      this.ragService.hasDocumentPath(resolvedPath);

    if (!readablePath) {
      throw new Error(
        'The file reader can only access files from the connected workspace folder, app workspace, imported knowledge, or known attachments.'
      );
    }

    const fileStat = await stat(resolvedPath);

    if (!fileStat.isFile()) {
      throw new Error(
        `The path \`${candidatePath}\` is a directory, not a file. Use the workspace-lister tool to list directory contents.`
      );
    }

    if (fileStat.size > MAX_FILE_READER_BYTES) {
      throw new Error('The file is too large for the safe reader limit.');
    }

    if (isBinaryExtension(resolvedPath)) {
      throw new Error(
        `Cannot read \`${path.basename(resolvedPath)}\` — binary files are not supported.`
      );
    }

    const buffer = await readFile(resolvedPath);

    if (buffer.includes(0)) {
      throw new Error('The file appears to be binary and cannot be read as text.');
    }

    const contents = buffer.toString('utf8').slice(0, MAX_FILE_READER_CHARACTERS);
    const source = contextSourceSchema.parse({
      id: randomUUID(),
      kind: 'document_chunk',
      label: path.basename(resolvedPath),
      excerpt: contents.slice(0, 600),
      sourcePath: resolvedPath,
      documentId: null,
      score: null
    });

    return {
      assistantContent: `### File Reader\n\nRead \`${resolvedPath}\`\n\n\`\`\`text\n${contents}\n\`\`\``,
      toolInvocations: [
        createInvocation({
          toolId: 'file-reader',
          displayName: 'File Reader',
          status: 'completed',
          inputSummary: resolvedPath,
          outputSummary: contents.slice(0, 300),
          errorMessage: null
        })
      ],
      contextSources: [source]
    };
  }

  private async executeWorkspaceLister(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<ToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('Connect a workspace folder before listing project files.');
    }

    const candidatePath = extractWorkspaceListPath(prompt);
    const resolvedPath = resolveWorkspacePath(candidatePath, workspaceRootPath);
    const directoryStat = await stat(resolvedPath);

    if (!directoryStat.isDirectory()) {
      throw new Error('Workspace listing requires a directory path.');
    }

    const snapshot = await buildRecursiveDirectorySnapshot(resolvedPath, MAX_RECURSIVE_LIST_ENTRIES);
    const relativePath = path.relative(workspaceRootPath, resolvedPath) || '.';
    const outputSummary = `${snapshot.totalFiles} file(s), ${snapshot.totalDirs} folder(s)`;
    const excerpt = snapshot.flatPaths.join('\n');

    return {
      assistantContent: [
        '### Workspace Lister',
        '',
        `Listing \`${relativePath}\` (recursive) inside the connected workspace folder.`,
        '',
        '```',
        ...snapshot.lines,
        '```',
        snapshot.truncated
          ? `\n> Showing the first ${MAX_RECURSIVE_LIST_ENTRIES} entries. Some files may be omitted.`
          : ''
      ]
        .filter(Boolean)
        .join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'workspace-lister',
          displayName: 'Workspace Lister',
          status: 'completed',
          inputSummary: relativePath,
          outputSummary,
          errorMessage: null
        })
      ],
      contextSources: [
        contextSourceSchema.parse({
          id: randomUUID(),
          kind: 'document_chunk',
          label: relativePath === '.' ? 'workspace-root' : relativePath,
          excerpt,
          sourcePath: resolvedPath,
          documentId: null,
          score: null
        })
      ]
    };
  }

  private async executeWorkspaceOpener(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<ToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('Connect a workspace folder before opening project files.');
    }

    if (!this.workspacePathLauncher) {
      throw new Error('Workspace opener is not available in this environment.');
    }

    const candidatePath = extractWorkspaceOpenPath(prompt);

    if (!candidatePath) {
      throw new Error('Provide a file or folder to open after /open.');
    }

    const resolvedPath = await this.resolveWorkspaceOpenTarget(
      candidatePath,
      workspaceRootPath
    );
    const targetStat = await stat(resolvedPath);

    if (!targetStat.isDirectory() && !targetStat.isFile()) {
      throw new Error('The requested workspace target is neither a file nor a folder.');
    }

    if (
      targetStat.isFile() &&
      DANGEROUS_OPEN_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())
    ) {
      throw new Error('Opening executable or script files is blocked for safety.');
    }

    const openError = await this.workspacePathLauncher(resolvedPath);

    if (typeof openError === 'string' && openError.trim().length > 0) {
      throw new Error(openError.trim());
    }

    const relativePath = path.relative(workspaceRootPath, resolvedPath) || '.';
    const kindLabel = targetStat.isDirectory() ? 'folder' : 'file';

    return {
      assistantContent: `### Workspace Opener\n\nOpened ${kindLabel} \`${relativePath}\` with the system default app.`,
      toolInvocations: [
        createInvocation({
          toolId: 'workspace-opener',
          displayName: 'Workspace Opener',
          status: 'completed',
          inputSummary: relativePath,
          outputSummary: `Opened ${kindLabel}`,
          errorMessage: null
        })
      ],
      contextSources: [
        contextSourceSchema.parse({
          id: randomUUID(),
          kind: 'document_chunk',
          label: relativePath === '.' ? 'workspace-root' : relativePath,
          excerpt: `Opened ${kindLabel}: ${relativePath}`,
          sourcePath: resolvedPath,
          documentId: null,
          score: null
        })
      ]
    };
  }

  private async executeWorkspaceSearch(
    prompt: string,
    workspaceRootPath: string | null
  ): Promise<ToolExecutionResult> {
    if (!workspaceRootPath) {
      throw new Error('Connect a workspace folder before searching project files.');
    }

    const query = prompt.trim();

    if (!query) {
      throw new Error('Provide a search query after /grep.');
    }

    const matches = await this.collectWorkspaceSearchMatches(workspaceRootPath, query);

    if (matches.length === 0) {
      const rootEntries = await readdir(workspaceRootPath, { withFileTypes: true });
      const snapshot = buildWorkspaceDirectorySnapshot(
        rootEntries,
        MAX_WORKSPACE_ROOT_SNAPSHOT_ENTRIES
      );

      return {
        assistantContent: [
          '### Workspace Search',
          '',
          `No direct matches were found for \`${query}\`, but the connected workspace folder is available.`,
          '',
          `Top-level workspace items (${snapshot.totalEntries} total):`,
          '',
          ...snapshot.renderedEntries,
          snapshot.truncated
            ? `\nShowing the first ${MAX_WORKSPACE_ROOT_SNAPSHOT_ENTRIES} items.`
            : ''
        ]
          .filter(Boolean)
          .join('\n'),
        toolInvocations: [
          createInvocation({
            toolId: 'workspace-search',
            displayName: 'Workspace Search',
            status: 'completed',
            inputSummary: query,
            outputSummary: `No direct matches; workspace root has ${snapshot.totalEntries} item(s).`,
            errorMessage: null
          })
        ],
        contextSources: [
          contextSourceSchema.parse({
            id: randomUUID(),
            kind: 'document_chunk',
            label: 'workspace-root',
            excerpt: snapshot.excerpt,
            sourcePath: workspaceRootPath,
            documentId: null,
            score: null
          })
        ]
      };
    }

    return {
      assistantContent: [
        '### Workspace Search',
        '',
        `Found ${matches.length} match(es) for \`${query}\`.`,
        '',
        ...matches.flatMap((match, index) => [
          `${index + 1}. \`${match.label}\``,
          `   ${match.excerpt}`
        ])
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'workspace-search',
          displayName: 'Workspace Search',
          status: 'completed',
          inputSummary: query,
          outputSummary: `${matches.length} match(es)`,
          errorMessage: null
        })
      ],
      contextSources: matches.map((match) =>
        contextSourceSchema.parse({
          id: randomUUID(),
          kind: 'document_chunk',
          label: match.label,
          excerpt: match.excerpt,
          sourcePath: match.sourcePath,
          documentId: null,
          score: null
        })
      )
    };
  }

  private executeKnowledgeSearch(
    prompt: string,
    workspaceId: string | null
  ): ToolExecutionResult {
    if (!workspaceId) {
      throw new Error('Select a workspace before searching imported knowledge.');
    }

    const query = prompt.trim();

    if (!query) {
      throw new Error('Provide a search query after /knowledge.');
    }

    const sources = this.ragService.searchWorkspaceKnowledge(
      workspaceId,
      query,
      KNOWLEDGE_SEARCH_RESULT_LIMIT
    );
    const outputSummary =
      sources.length > 0
        ? `${sources.length} grounded source(s)`
        : 'No workspace knowledge matches found.';

    return {
      assistantContent:
        sources.length > 0
          ? [
              '### Knowledge Search',
              '',
              `Found ${sources.length} grounded source(s) for \`${query}\`.`,
              '',
              ...sources.flatMap((source, index) => [
                `[Source ${index + 1}] ${source.label}${source.sourcePath ? ` (${source.sourcePath})` : ''}`,
                source.excerpt
              ])
            ].join('\n\n')
          : `### Knowledge Search\n\nNo workspace knowledge matches were found for \`${query}\`.`,
      toolInvocations: [
        createInvocation({
          toolId: 'knowledge-search',
          displayName: 'Knowledge Search',
          status: 'completed',
          inputSummary: query,
          outputSummary,
          errorMessage: null
        })
      ],
      contextSources: sources
    };
  }

  private async executeWebSearch(prompt: string): Promise<ToolExecutionResult> {
    const query = extractWebSearchQuery(prompt);

    if (!query) {
      throw new Error('Provide a search query after /web.');
    }

    const results = await this.webSearcher(query, WEB_SEARCH_RESULT_LIMIT);

    return {
      assistantContent: [
        '### Web Search',
        '',
        `Found ${results.length} web result(s) for \`${query}\`.`,
        '',
        ...results.flatMap((result, index) => [
          `${index + 1}. ${result.title}`,
          `   ${result.url}`,
          `   ${result.snippet}`
        ])
      ].join('\n'),
      toolInvocations: [
        createInvocation({
          toolId: 'web-search',
          displayName: 'Web Search',
          status: 'completed',
          inputSummary: query,
          outputSummary: `${results.length} web result(s)`,
          errorMessage: null
        })
      ],
      contextSources: results.map((result, index) =>
        contextSourceSchema.parse({
          id: randomUUID(),
          kind: 'document_chunk',
          label: result.title,
          excerpt: result.snippet,
          sourcePath: result.url,
          documentId: null,
          score: Number((1 - index / Math.max(results.length, 1)).toFixed(6))
        })
      )
    };
  }

  private async collectWorkspaceSearchMatches(
    workspaceRootPath: string,
    query: string
  ): Promise<WorkspaceSearchMatch[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const queryTokens = normalizeSearchTokens(query);
    const pendingDirectories = [workspaceRootPath];
    const matches: WorkspaceSearchMatch[] = [];
    let scannedFiles = 0;

    while (pendingDirectories.length > 0 && scannedFiles < MAX_WORKSPACE_SEARCH_FILES) {
      const currentDirectory = pendingDirectories.shift();

      if (!currentDirectory) {
        break;
      }

      const entries = await readdir(currentDirectory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const entryPath = path.join(currentDirectory, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
            pendingDirectories.push(entryPath);
          }

          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        scannedFiles += 1;
        const relativePath = path.relative(workspaceRootPath, entryPath) || entry.name;
        const relativePathLower = relativePath.toLowerCase();
        const filenameMatched =
          relativePathLower.includes(normalizedQuery) ||
          includesAllTokens(relativePathLower, queryTokens);

        if (filenameMatched) {
          matches.push({
            sourcePath: entryPath,
            label: relativePath,
            excerpt: `Filename match: ${relativePath}`
          });
        } else if (isLikelyTextFile(entryPath)) {
          const textContents = await readSearchableTextFile(entryPath);

          if (textContents) {
            const normalizedContents = textContents.toLowerCase();
            const contentMatched =
              normalizedContents.includes(normalizedQuery) ||
              includesAllTokens(normalizedContents, queryTokens);

            if (contentMatched) {
              matches.push({
                sourcePath: entryPath,
                label: relativePath,
                excerpt: buildSearchExcerpt(textContents, normalizedQuery, queryTokens)
              });
            }
          }
        }

        if (
          matches.length >= MAX_WORKSPACE_SEARCH_RESULTS ||
          scannedFiles >= MAX_WORKSPACE_SEARCH_FILES
        ) {
          return matches.slice(0, MAX_WORKSPACE_SEARCH_RESULTS);
        }
      }
    }

    return matches.slice(0, MAX_WORKSPACE_SEARCH_RESULTS);
  }

  private async resolveWorkspaceOpenTarget(
    candidatePath: string,
    workspaceRootPath: string
  ): Promise<string> {
    try {
      const resolvedPath = resolveWorkspacePath(candidatePath, workspaceRootPath);
      await stat(resolvedPath);
      return resolvedPath;
    } catch (error) {
      if (
        path.isAbsolute(candidatePath) ||
        candidatePath.includes('/') ||
        candidatePath.includes('\\')
      ) {
        throw error;
      }
    }

    const basenameMatches = await this.findWorkspaceMatchesByBasename(
      workspaceRootPath,
      candidatePath
    );

    const firstMatch = basenameMatches[0];

    if (basenameMatches.length === 1 && firstMatch) {
      return firstMatch;
    }

    if (basenameMatches.length > 1) {
      const renderedMatches = basenameMatches
        .slice(0, 5)
        .map((match) => path.relative(workspaceRootPath, match) || '.')
        .join(', ');

      throw new Error(
        `Multiple workspace items matched "${candidatePath}": ${renderedMatches}. Use a more specific path.`
      );
    }

    throw new Error(`Could not find "${candidatePath}" inside the connected workspace folder.`);
  }

  private async findWorkspaceMatchesByBasename(
    workspaceRootPath: string,
    basename: string
  ): Promise<string[]> {
    const normalizedBasename = basename.trim().toLowerCase();
    const pendingDirectories = [workspaceRootPath];
    const matches: string[] = [];
    let scannedEntries = 0;

    while (
      pendingDirectories.length > 0 &&
      scannedEntries < MAX_WORKSPACE_OPEN_SEARCH_ENTRIES
    ) {
      const currentDirectory = pendingDirectories.shift();

      if (!currentDirectory) {
        break;
      }

      const entries = await readdir(currentDirectory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const entryPath = path.join(currentDirectory, entry.name);
        scannedEntries += 1;

        if (entry.name.toLowerCase() === normalizedBasename) {
          matches.push(entryPath);
        }

        if (
          entry.isDirectory() &&
          !IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())
        ) {
          pendingDirectories.push(entryPath);
        }

        if (
          matches.length >= 6 ||
          scannedEntries >= MAX_WORKSPACE_OPEN_SEARCH_ENTRIES
        ) {
          return matches;
        }
      }
    }

    return matches;
  }
}

function summarizeToolOutput(value: string): string | null {
  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 300);
}

function getRawToolArg(args: Record<string, unknown>): string | null {
  const rawValue = args.__raw;

  return typeof rawValue === 'string' && rawValue.trim().length > 0
    ? rawValue.trim()
    : null;
}

function getStringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }

  return '';
}

export function listBuiltinTools(): ToolDefinition[] {
  return [...builtinTools];
}
