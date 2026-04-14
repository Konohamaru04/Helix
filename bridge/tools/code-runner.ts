import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const CODE_RUNNER_TIMEOUT_MS = 5_000;
const CODE_RUNNER_MAX_STDIO_CHARS = 4_000;
const CODE_RUNNER_SANDBOX_PREFIX = 'ollama-desktop-code-runner-';
const SUPPORTED_FENCE_LANGUAGES = new Set(['', 'javascript', 'js', 'node']);
const BLOCKED_CODE_RUNNER_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s+.+\s+from\s+/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bBuffer\b/,
  /\bDeno\b/,
  /\bBun\b/,
  /\bSharedArrayBuffer\b/,
  /\bAtomics\b/
];

export interface CodeRunResult {
  language: 'javascript';
  stdout: string;
  stderr: string;
  result: string | null;
  durationMs: number;
  timedOut: boolean;
}

interface ExtractedCodeSnippet {
  language: string;
  code: string;
}

function trimOutput(value: string): string {
  if (value.length <= CODE_RUNNER_MAX_STDIO_CHARS) {
    return value;
  }

  return `${value.slice(0, CODE_RUNNER_MAX_STDIO_CHARS)}\n... output truncated ...`;
}

function normalizePromptForExecution(prompt: string): string {
  return prompt
    .trim()
    .replace(/^(?:please\s+)?(?:run|execute|test|evaluate)\s+(?:this\s+)?(?:javascript|js|node)?\s*(?:code|snippet)?[:\s-]*/i, '')
    .trim();
}

function extractFencedCode(prompt: string): ExtractedCodeSnippet | null {
  const fencedMatch = prompt.match(/```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/);

  if (!fencedMatch) {
    return null;
  }

  return {
    language: fencedMatch[1]?.trim().toLowerCase() ?? '',
    code: fencedMatch[2]?.trim() ?? ''
  };
}

function looksLikeInlineJavaScript(code: string): boolean {
  return (
    /(?:=>|console\.|const\s+|let\s+|var\s+|function\s+|class\s+|return\s+|await\s+|new\s+)/.test(
      code
    ) ||
    /[;{}]/.test(code) ||
    code.includes('\n')
  );
}

function extractRunnableSnippet(prompt: string): ExtractedCodeSnippet {
  const normalizedPrompt = normalizePromptForExecution(prompt);
  const fencedSnippet = extractFencedCode(normalizedPrompt);

  if (fencedSnippet) {
    if (!SUPPORTED_FENCE_LANGUAGES.has(fencedSnippet.language)) {
      throw new Error(
        'The safe code runner currently supports dependency-free JavaScript snippets only.'
      );
    }

    if (!fencedSnippet.code) {
      throw new Error('Provide JavaScript code inside the fenced block before running it.');
    }

    return {
      language: 'javascript',
      code: fencedSnippet.code
    };
  }

  if (!normalizedPrompt) {
    throw new Error('Provide a JavaScript snippet after /run.');
  }

  return {
    language: 'javascript',
    code: normalizedPrompt
  };
}

function validateJavaScriptSnippet(code: string) {
  for (const pattern of BLOCKED_CODE_RUNNER_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(
        'The safe code runner blocks imports, process access, networking, and other host APIs.'
      );
    }
  }
}

function shouldTreatAsExpression(code: string): boolean {
  const trimmedCode = code.trim();

  return (
    trimmedCode.length > 0 &&
    !looksLikeInlineJavaScript(trimmedCode) &&
    !/^(?:if|for|while|switch|try|return|throw|async\s+function|function|class)\b/.test(
      trimmedCode
    )
  );
}

function createWorkerSource(): string {
  return [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const vm = require('node:vm');",
    "const { inspect } = require('node:util');",
    '',
    'function formatValue(value) {',
    "  if (typeof value === 'string') {",
    '    return value;',
    '  }',
    '',
    '  return inspect(value, { depth: 4, breakLength: 80, maxArrayLength: 40 });',
    '}',
    '',
    'const stdoutLines = [];',
    'const stderrLines = [];',
    'const consoleBridge = {',
    "  log: (...args) => stdoutLines.push(args.map(formatValue).join(' ')),",
    "  info: (...args) => stdoutLines.push(args.map(formatValue).join(' ')),",
    "  warn: (...args) => stderrLines.push(args.map(formatValue).join(' ')),",
    "  error: (...args) => stderrLines.push(args.map(formatValue).join(' '))",
    '};',
    'const sandbox = {',
    '  console: consoleBridge,',
    '  Math,',
    '  JSON,',
    '  Date,',
    '  Array,',
    '  Object,',
    '  Number,',
    '  String,',
    '  Boolean,',
    '  RegExp,',
    '  Map,',
    '  Set,',
    '  URL,',
    '  URLSearchParams',
    '};',
    '',
    'async function run() {',
    "  const context = vm.createContext(sandbox, { name: 'ollama-desktop-code-runner' });",
    '  const wrappedCode = workerData.expression',
    "    ? '(async () => (' + workerData.code + '))()'",
    "    : '(async () => {\\n' + workerData.code + '\\n})()';",
    '  const script = new vm.Script(wrappedCode, {',
    "    filename: 'snippet.js',",
    '    displayErrors: true',
    '  });',
    '  const result = await script.runInContext(context, {',
    '    timeout: workerData.timeoutMs',
    '  });',
    '',
    '  parentPort.postMessage({',
    '    ok: true,',
    "    stdout: stdoutLines.join('\\n'),",
    "    stderr: stderrLines.join('\\n'),",
    '    result: result === undefined ? null : formatValue(result)',
    '  });',
    '}',
    '',
    'run().catch((error) => {',
    '  parentPort.postMessage({',
    '    ok: false,',
    "    stdout: stdoutLines.join('\\n'),",
    "    stderr: stderrLines.join('\\n'),",
    '    error: error instanceof Error ? (error.stack || error.message) : String(error)',
    '  });',
    '});'
  ].join('\n');
}

async function executeJavaScript(code: string): Promise<CodeRunResult> {
  const sandboxDirectory = await mkdtemp(
    path.join(tmpdir(), CODE_RUNNER_SANDBOX_PREFIX)
  );
  const expression = shouldTreatAsExpression(code);
  const startedAt = Date.now();

  try {
    return await new Promise<CodeRunResult>((resolve, reject) => {
      const worker = new Worker(createWorkerSource(), {
        eval: true,
        workerData: {
          code,
          expression,
          timeoutMs: CODE_RUNNER_TIMEOUT_MS
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 32
        }
      });

      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        void worker.terminate().then(() => {
          resolve({
            language: 'javascript',
            stdout: '',
            stderr: 'Execution timed out.',
            result: null,
            durationMs: Date.now() - startedAt,
            timedOut: true
          });
        });
      }, CODE_RUNNER_TIMEOUT_MS + 150);

      worker.once('message', (message: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        void worker.terminate();

        const payload = message as {
          ok: boolean;
          stdout?: string;
          stderr?: string;
          result?: string | null;
          error?: string;
        };

        if (!payload.ok) {
          reject(
            new Error(
              trimOutput(
                payload.error?.trim() ||
                  payload.stderr?.trim() ||
                  'Code execution failed.'
              )
            )
          );
          return;
        }

        resolve({
          language: 'javascript',
          stdout: trimOutput(payload.stdout?.trim() ?? ''),
          stderr: trimOutput(payload.stderr?.trim() ?? ''),
          result: payload.result?.trim() ?? null,
          durationMs: Date.now() - startedAt,
          timedOut: false
        });
      });

      worker.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        reject(
          error instanceof Error ? error : new Error(String(error))
        );
      });

      worker.once('exit', (code) => {
        if (settled || code === 0) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`Code runner worker exited unexpectedly with code ${code}.`));
      });
    });
  } finally {
    await rm(sandboxDirectory, { recursive: true, force: true });
  }
}

export async function runCodeSnippet(prompt: string): Promise<CodeRunResult> {
  const snippet = extractRunnableSnippet(prompt);

  if (snippet.language !== 'javascript') {
    throw new Error(
      'The safe code runner currently supports dependency-free JavaScript snippets only.'
    );
  }

  validateJavaScriptSnippet(snippet.code);
  return executeJavaScript(snippet.code);
}
