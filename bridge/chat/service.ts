import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import {
  canInlineAttachmentText,
  inferMimeType,
  isImageFilePath
} from '@bridge/chat/attachment-utils';
import type { TurnMetadataService } from '@bridge/chat/turn-metadata';
import { buildConversationContext } from '@bridge/context';
import type {
  CancelChatTurnInput,
  ChatStartAccepted,
  ContextSource,
  ConversationExportPayload,
  CreateWorkspaceInput,
  EditMessageInput,
  ChatStreamEvent,
  ChatTurnAccepted,
  ChatTurnRequest,
  GenerationJob,
  ImportWorkspaceKnowledgeResult,
  KnowledgeDocument,
  MessageAttachment,
  MessageUsage,
  OllamaThinkMode,
  RegenerateResponseInput,
  RouteTrace,
  SkillDefinition,
  StoredMessage,
  TextInferenceBackend,
  ToolDefinition,
  ToolInvocation,
  UserSettings
} from '@bridge/ipc/contracts';
import {
  cancelChatTurnInputSchema,
  chatStartAcceptedSchema,
  chatTurnAcceptedSchema,
  chatTurnRequestSchema,
  conversationExportPayloadSchema,
  createWorkspaceInputSchema,
  editMessageInputSchema,
  exportConversationInputSchema,
  importConversationResultSchema,
  importWorkspaceKnowledgeResultSchema,
  messageAttachmentSchema,
  regenerateResponseInputSchema,
  updateWorkspaceRootInputSchema,
  storedMessageSchema
} from '@bridge/ipc/contracts';
import type { MemoryService } from '@bridge/memory';
import type { NvidiaClient } from '@bridge/nvidia/client';
import type {
  OllamaChatMessage,
  OllamaChatCompletion,
  OllamaClient,
  OllamaToolCall,
  OllamaToolDefinition
} from '@bridge/ollama/client';
import type { BridgeQueue } from '@bridge/queue';
import type { RagService } from '@bridge/rag';
import type { GenerationRepository } from '@bridge/generation/repository';
import type { GenerationService } from '@bridge/generation/service';
import {
  isTrustedModelRouteAnalysis,
  type ChatRouter,
  type ModelRouteAnalysis,
  type RouteDecision,
  type RouteInput
} from '@bridge/router';
import { parseJsonishRecord } from '@bridge/jsonish';
import type { SettingsService } from '@bridge/settings/service';
import type { SkillRegistry } from '@bridge/skills';
import type { ToolDispatcher } from '@bridge/tools';
import type { Logger } from 'pino';
import type { ChatRepository } from './repository';

const MAX_ATTACHMENT_TEXT_CHARS = 12_000;
const MAX_ATTACHMENT_PREVIEW_BYTES = 8 * 1024 * 1024;
const FOLLOW_UP_TOOL_RETRY_PATTERN =
  /^(?:continue|same|same tool|that tool|again|try again|fix this|do the same|use that|use that tool|use that tool again)$/i;
const FOLLOW_UP_TOOL_CORRECTION_PATTERN =
  /\b(correct|right|actual(?:ly)?|meant|instead|directory|folder|path|root)\b/i;
const LIKELY_TOOL_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\.{1,2}[\\/]|~?[\\/])[^\s"'`]+|\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\b/i;
const IMAGE_ANALYSIS_PATTERN =
  /\b(describe|identify|who(?:'s| is)|what(?:'s| is| are)|caption|analy[sz]e|count|read|transcribe|ocr|summari[sz]e|detect|classify|recognize|compare)\b/i;
const IMAGE_GENERATION_PATTERN =
  /\b(generate|create|make|draw|render|design|illustrate|paint|produce|imagine|craft)\b/i;
const IMAGE_EDIT_PATTERN =
  /\b(edit|modify|change|swap|replace|remove|add|turn|transform|restyle|recolor|repaint|retouch|upscale|enhance|extend|outpaint|inpaint|background|foreground|outfit|clothing|clothes|hair|face|expression|pose)\b/i;
const IMAGE_OBJECT_PATTERN =
  /\b(image|photo|picture|portrait|art|artwork|illustration|poster|wallpaper|logo|icon|avatar|scene|character|texture|background|person|people|subject|look|style|outfit|clothing)\b/i;
const IMAGE_FOLLOW_UP_PATTERN =
  /^(?:now|also|instead|same image|same person|same character|same subject|same one|make it|make them|turn it|turn them|change it|change them|swap|replace|remove|add|restyle|recolor)\b/i;
const IMAGE_RETRY_PATTERN =
  /^(?:again|try again|retry|regenerate|one more|another version|another variation|variation please)\b$/i;
const IMAGE_PROMPT_AUTHORING_PATTERN =
  /\b(?:image generation|text-to-image|diffusion|midjourney|stable diffusion|sdxl|flux|dall[- ]?e)\b[\s\S]{0,32}\bprompt\b|\bprompt\b[\s\S]{0,32}\b(?:image generation|text-to-image|diffusion|midjourney|stable diffusion|sdxl|flux|dall[- ]?e)\b/i;
const PROMPT_AUTHORING_VERB_PATTERN =
  /\b(write|rewrite|create|generate|make|craft|draft|refine|improve|optimi[sz]e|adapt|convert|turn|suggest|give)\b/i;
const IMAGE_RESTORE_PATTERN =
  /\b(?:back to (?:the )?original|change (?:it|them|this) back|restore(?: (?:it|them|this))?|revert(?: (?:it|them|this))?|undo(?: (?:the )?edit)?|same as before|as before|like before|original (?:look|clothing|clothes|outfit|style)|previous (?:look|clothing|clothes|outfit|style))\b/i;
const ROUTE_ANALYSIS_RECENT_MESSAGE_LIMIT = 4;
const ROUTE_ANALYSIS_MESSAGE_CHAR_LIMIT = 280;
const MAX_LOGGED_TEXT_CHARS = 4_000;
const DEFAULT_MAX_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const MAX_LOCAL_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const LOCAL_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const CODING_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const LOCAL_CODING_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const MAX_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const MAX_CODING_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const MAX_LOCAL_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const MAX_LOCAL_CODING_NATIVE_TOOL_CALL_ROUNDS = Number.MAX_SAFE_INTEGER;
const CODING_NATIVE_TOOL_ROUND_EXTENSION = Number.MAX_SAFE_INTEGER;
const LOCAL_CODING_NATIVE_TOOL_ROUND_EXTENSION = Number.MAX_SAFE_INTEGER;
const MAX_MISSING_TOOL_CALL_REMINDERS = 2;
const MAX_FAILED_TOOL_RECOVERY_REMINDERS = 2;
const MIN_DYNAMIC_NUM_CTX = 4_096;
const CLOUD_NUM_CTX_LIMIT = 200_000;
const CLOUD_SESSION_TOKEN_LIMIT = 1_000_000;
const CLOUD_NUM_CTX_MIN_HEADROOM = 4_096;
const LOCAL_NUM_CTX_MAX = 131_072;
const LOCAL_NUM_CTX_MIN_HEADROOM = 2_048;
const LOCAL_NUM_CTX_SYSTEM_HEADROOM_BYTES = 2 * 1024 ** 3;
const LOCAL_NUM_CTX_BYTES_PER_TOKEN = 256 * 1024;
const LOCAL_NUM_CTX_MODEL_PENALTY_PER_GIB = 1_024;
const BYTES_PER_GIB = 1024 ** 3;
const INLINE_TOOL_CALL_ROUND_LIMIT = Number.MAX_SAFE_INTEGER;
const INLINE_TOOL_CALL_SEGMENT_PATTERN =
  /<\|?tool_call_begin\|?>\s*functions?\.(?<tool>[A-Za-z0-9_-]+)(?:\.\d+)?\s*<\|?tool_call_argument_begin\|?>\s*(?<args>[\s\S]*?)\s*<\|?tool_call_end\|?>/gi;
const INLINE_TOOL_CALL_WRAPPER_PATTERN = /<\|?tool_calls_section_(?:begin|end)\|?>/gi;
const NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `You can use local tools to inspect and modify the connected workspace.
Work efficiently:
- Read a file before modifying it — never assume its current contents.
- For small, targeted changes use edit({filePath, startLine, endLine, newText}) — read the file first to get exact line numbers.
- For changes that touch most of a file, use write({filePath, content}) with the complete new file contents.
- Batch independent tool calls in one response instead of one call per turn.
- When the task is done, stop calling tools and answer the user directly with a concise summary of what changed and why.`;
const CODING_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For coding tasks in the connected workspace, follow an implement-verify loop:
- Before modifying, read the target file and any direct callers or imports that the change will affect.
- For small, targeted changes use edit({filePath, startLine, endLine, newText}) — read the file first to get exact line numbers.
- For changes that restructure or touch most of a file, use write({filePath, content}) with the complete new file contents.
- For larger scaffolds, batch several related edits or writes in the same response instead of one file per round.
- After modifying, re-read every changed section to confirm correctness before proceeding.
- Run the most relevant bounded validation command (typecheck, lint, or targeted test) before stopping.
- If validation fails due to your changes, diagnose the error message, fix the root cause, and re-run — do not stop on a failing result.
- If automated validation is unavailable, re-read all changed files and explicitly confirm the stated requirement is met.`;
const REPOSITORY_ANALYSIS_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For repository or codebase analysis tasks in the connected workspace:
- Do not stop after listing directories.
- Use workspace-search or glob to find important manifests, configs, docs, entrypoints, and representative source files.
- Use read or file-reader to inspect actual file contents before you summarize the implementation.
- Do not claim you lack access to internal file contents while those tools are available.
- If the user asks for a markup summary file, write it only after the summary is grounded in inspected files.`;
function buildPlanContextPrompt(
  planContext: { planState: import('@bridge/ipc/contracts').PlanState | null; tasks: import('@bridge/ipc/contracts').CapabilityTask[] }
): string | null {
  const { planState, tasks } = planContext;
  const planActive = planState?.status === 'active';

  if (!planActive && tasks.length === 0) {
    return null;
  }

  const lines: string[] = [
    `Plan mode: ${planActive ? `ACTIVE (conversation ${planState?.conversationId ?? 'unknown'})` : 'INACTIVE'}`,
    '',
    `Tracked tasks — use these exact IDs for task-update and task-stop:`
  ];

  if (tasks.length === 0) {
    lines.push('(no tasks yet)');
  } else {
    for (const t of tasks) {
      lines.push(`${t.sequence}. [${t.status}] \`${t.id}\` | ${t.title}${t.details ? ` — ${t.details}` : ''}`);
    }
  }

  return lines.join('\n');
}

const PLAN_MODE_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For any multi-step task, activate plan mode and track your work with tasks before starting:
1. Call enter-plan-mode first to activate structured planning for this conversation.
2. Call task-create for each distinct unit of work — one task per major step or deliverable.
3. When you begin a step, call task-update with status "in_progress".
4. When a step is complete, call task-update with status "completed".
5. If a planned step becomes unnecessary, call task-stop to cancel it.
6. After all tasks are complete and the user's goal is fully met, call exit-plan-mode.
For trivial single-step requests that require only one tool call, you may skip plan mode.`;
const NATIVE_TOOL_USE_REQUIRED_SYSTEM_PROMPT = `This turn was opened in the local tool loop because the request depends on tools or workspace state.
Do not answer from memory alone.
Choose the next tool call now instead of finishing the turn.`;
const INTERCEPTED_TOOL_CALL_CONTINUATION_SYSTEM_PROMPT = `A tool-call block in your previous response was intercepted and executed by the bridge.
- Do not repeat tool-call markup that already ran.
- If you still need another tool, respond only with the same tool-call markup block and no surrounding prose.
- When the task is complete, answer normally in plain text with no tool-call markup.`;
const TOOL_FAILURE_RECOVERY_SYSTEM_PROMPT = `The latest tool call failed and the task is not complete yet.
Do not stop after a recoverable tool failure.
Retry with corrected arguments or choose a better tool for the next step.`;
const CODING_VERIFICATION_REMINDER_SYSTEM_PROMPT = `You already modified files in this coding turn, but the latest changes have not been verified yet.
Before you finish:
- inspect the updated files,
- run the most relevant bounded validation command when practical,
- and if validation fails because of your changes, continue fixing and re-checking.
Do not end the turn yet; keep using tools until the latest changes are verified or you can report a concrete blocker.`;
const CODING_MUTATION_TOOL_IDS = new Set(['write', 'edit', 'notebook-edit']);
const CODING_VERIFICATION_TOOL_IDS = new Set([
  'read',
  'file-reader',
  'glob',
  'grep',
  'workspace-search',
  //'bash',
  'powershell',
  'lsp'
]);
const NATIVE_TOOL_LOOP_ESCALATION_TOOL_IDS = new Set([
  'read',
  'file-reader',
  'workspace-lister',
  'workspace-search',
  'glob',
  'grep',
  'lsp'
]);
const NATIVE_TOOL_CALLING_PATTERN =
  /\b(read|open|list|show|search|find|grep|glob|fetch|download|task|tasks|schedule|cron|worktree|definition|references|diagnostics|calculate|compute|powershell|command|tool|tools|agent|subagent|team|todo|checklist|milestone|notebook|resource|mcp|clarify|skill)\b|plan mode|https?:\/\/|[A-Za-z]:\\|\.{1,2}[\\/]/i;
const NATIVE_FILE_MUTATION_PATTERN =
  /\b(write|save|create|update|modify|change|fix|rewrite|correct|repair)\b[\s\S]{0,64}(?:\b(file|folder|directory|document|notebook|markdown|json|yaml|yml|toml|txt|ts|tsx|js|jsx|py|sql|css|html|md|readme)\b|(?:[A-Za-z]:\\|\.{0,2}[\\/]|\/)?[A-Za-z0-9_.-]+\.(?:md|json|yaml|yml|toml|txt|ts|tsx|js|jsx|py|sql|css|html))\b/i;
const ROUTE_ANALYSIS_SYSTEM_PROMPT = `You are the routing classifier for a local-first desktop AI application.
Decide the best internal handling path for the latest user turn.
Never answer the user request itself.
Return only minified JSON with this exact shape:
{"toolId":string|null,"skillId":string|null,"needsVision":boolean,"prefersCode":boolean,"useWorkspaceKnowledge":boolean,"imageMode":"none"|"text-to-image"|"image-to-image"|"prompt-authoring","confidence":number,"reason":string}
Rules:
- Set toolId only when one listed tool is the best action.
- Set skillId only when one listed skill is the best chat behavior.
- Set imageMode="text-to-image" only when the app should generate a new image now.
- Set imageMode="image-to-image" only when the app should edit or transform an image now using attached or recent image context.
- Set imageMode="prompt-authoring" when the user wants a prompt for another image model or wants prompt-writing help instead of generating the image now.
- If the user is describing or analyzing an image, set needsVision=true and imageMode="none".
- If unsure, keep toolId and skillId null, imageMode="none", and lower confidence.
- Never invent tool or skill ids.`;

type NativeToolWorkflowMode = 'default' | 'coding';
type OllamaThinkValue = boolean | 'low' | 'medium' | 'high';

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function estimateOllamaMessageTokens(messages: OllamaChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

function resolveOllamaThinkValue(thinkMode: OllamaThinkMode | undefined): OllamaThinkValue | undefined {
  if (!thinkMode) {
    return undefined;
  }

  if (thinkMode === 'on') {
    return true;
  }

  if (thinkMode === 'off') {
    return false;
  }

  return thinkMode;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType?.startsWith('image/') === true || isImageFilePath(attachment.fileName);
}

function looksLikeImageAnalysisPrompt(prompt: string): boolean {
  return IMAGE_ANALYSIS_PATTERN.test(prompt);
}

function looksLikeTextToImagePrompt(prompt: string): boolean {
  return IMAGE_GENERATION_PATTERN.test(prompt) && IMAGE_OBJECT_PATTERN.test(prompt);
}

function looksLikeImageEditPrompt(prompt: string): boolean {
  return IMAGE_EDIT_PATTERN.test(prompt);
}

function looksLikeImageFollowUpPrompt(prompt: string): boolean {
  return IMAGE_FOLLOW_UP_PATTERN.test(prompt) || looksLikeImageEditPrompt(prompt);
}

function looksLikeImagePromptAuthoringRequest(prompt: string): boolean {
  return (
    IMAGE_PROMPT_AUTHORING_PATTERN.test(prompt) ||
    (/\bprompt\b/i.test(prompt) && PROMPT_AUTHORING_VERB_PATTERN.test(prompt))
  );
}

function looksLikeImageRestorePrompt(prompt: string): boolean {
  return IMAGE_RESTORE_PATTERN.test(prompt);
}

function looksLikeRepositoryAnalysisPrompt(prompt: string): boolean {
  return (
    /\b(analy[sz]e|summari[sz]e|summary|overview|understand|explain|document|documentation|map|walk(?: me)? through)\b/i.test(
      prompt
    ) &&
    /\b(repo|repository|codebase|project|implementation|architecture)\b/i.test(prompt)
  );
}

function looksLikeNativeFileMutationPrompt(prompt: string): boolean {
  const trimmedPrompt = prompt.trim();

  if (!NATIVE_FILE_MUTATION_PATTERN.test(trimmedPrompt)) {
    return false;
  }

  const looksLikeDirectoryCorrectionOnly =
    FOLLOW_UP_TOOL_CORRECTION_PATTERN.test(trimmedPrompt) &&
    LIKELY_TOOL_PATH_PATTERN.test(trimmedPrompt) &&
    /\b(directory|folder|root)\b/i.test(trimmedPrompt) &&
    !/\b(file|document|markdown|readme|content|contents)\b/i.test(trimmedPrompt) &&
    !/[A-Za-z0-9_.-]+\.(?:md|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|sql|css|html)\b/i.test(
      trimmedPrompt
    );

  return !looksLikeDirectoryCorrectionOnly;
}

function getImageAttachmentKey(attachment: MessageAttachment): string {
  if (attachment.filePath) {
    return path.normalize(attachment.filePath).toLowerCase();
  }

  return `${attachment.fileName.toLowerCase()}:${attachment.createdAt}`;
}

function mergeDistinctImageAttachments(
  attachmentGroups: MessageAttachment[][],
  limit: number
): MessageAttachment[] {
  const merged: MessageAttachment[] = [];
  const seen = new Set<string>();

  for (const attachments of attachmentGroups) {
    for (const attachment of attachments) {
      if (!isImageAttachment(attachment)) {
        continue;
      }

      const key = getImageAttachmentKey(attachment);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(attachment);

      if (merged.length >= limit) {
        return merged;
      }
    }
  }

  return merged;
}

function buildRestoreImageEditPrompt(prompt: string): string {
  return `${prompt}\n\nEditing guidance: use the first reference image as the current image to edit and use any additional reference images as the earlier original look to restore.`;
}

function clipRouteAnalysisText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clipLoggedText(
  value: string | null | undefined,
  maxLength = MAX_LOGGED_TEXT_CHARS
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return normalized;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeLoggedAttachments(attachments: MessageAttachment[]) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    filePath: attachment.filePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes
  }));
}

function summarizeLoggedToolInvocations(toolInvocations: ToolInvocation[]) {
  return toolInvocations.map((invocation) => ({
    toolId: invocation.toolId,
    status: invocation.status,
    inputSummary: clipLoggedText(invocation.inputSummary, 800),
    outputSummary: clipLoggedText(invocation.outputSummary, 800),
    errorMessage: clipLoggedText(invocation.errorMessage, 800)
  }));
}

function isCodingMutationInvocation(invocation: ToolInvocation): boolean {
  return (
    invocation.status === 'completed' && CODING_MUTATION_TOOL_IDS.has(invocation.toolId)
  );
}

function isCodingVerificationInvocation(invocation: ToolInvocation): boolean {
  return CODING_VERIFICATION_TOOL_IDS.has(invocation.toolId);
}

function hasCodingVerificationAfterLatestMutation(toolInvocations: ToolInvocation[]): boolean {
  let latestMutationIndex = -1;

  for (let index = toolInvocations.length - 1; index >= 0; index -= 1) {
    if (isCodingMutationInvocation(toolInvocations[index] as ToolInvocation)) {
      latestMutationIndex = index;
      break;
    }
  }

  if (latestMutationIndex === -1) {
    return true;
  }

  return toolInvocations
    .slice(latestMutationIndex + 1)
    .some((invocation) => isCodingVerificationInvocation(invocation));
}

function listRecentCodingMutationTargets(toolInvocations: ToolInvocation[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (let index = toolInvocations.length - 1; index >= 0; index -= 1) {
    const invocation = toolInvocations[index];

    if (!invocation || !isCodingMutationInvocation(invocation)) {
      continue;
    }

    const rawTarget = invocation.inputSummary.trim();
    const target = rawTarget ? path.basename(rawTarget) || rawTarget : invocation.toolId;

    if (seen.has(target)) {
      continue;
    }

    seen.add(target);
    targets.push(target);

    if (targets.length >= 4) {
      break;
    }
  }

  return targets.reverse();
}

function buildCodingVerificationReminder(toolInvocations: ToolInvocation[]): string {
  const targets = listRecentCodingMutationTargets(toolInvocations);
  const targetLine =
    targets.length > 0
      ? `Latest changed files: ${targets.map((target) => `\`${target}\``).join(', ')}.`
      : 'Latest changed files are inside the connected workspace.';

  return `${CODING_VERIFICATION_REMINDER_SYSTEM_PROMPT}\n${targetLine}`;
}

function buildNativeToolReferencePrompt(toolDefinitions: OllamaToolDefinition[]): string {
  const availableTools = new Set(toolDefinitions.map((definition) => definition.function.name));
  const lines = ['Tool quick reference (use exact parameter names):'];

  // --- Discovery ---
  if (availableTools.has('workspace-lister')) {
    lines.push(
      '- `workspace-lister({path?})`: list all files and folders recursively. Omit path to start from workspace root.'
    );
  }
  if (availableTools.has('workspace-search')) {
    lines.push('- `workspace-search({query})`: search file names and file text content by keyword.');
  }
  if (availableTools.has('glob')) {
    lines.push(
      '- `glob({pattern?})`: find files by glob pattern, e.g. `src/**/*.ts` or `*.md`. Omit pattern to match all files.'
    );
  }
  if (availableTools.has('grep')) {
    lines.push('- `grep({query})`: search exact plain text across all workspace files.');
  }
  if (availableTools.has('knowledge-search')) {
    lines.push('- `knowledge-search({query})`: search the imported workspace knowledge base.');
  }
  if (availableTools.has('web-search')) {
    lines.push('- `web-search({query})`: search the public web and return linked snippets.');
  }
  if (availableTools.has('web-fetch')) {
    lines.push('- `web-fetch({url})`: fetch a remote URL and return a bounded text excerpt.');
  }

  // --- Reading ---
  if (availableTools.has('read')) {
    lines.push('- `read({filePath})`: read exact file contents. Always call before write.');
  }
  if (availableTools.has('file-reader')) {
    lines.push('- `file-reader({path})`: read a file from the app or workspace. Always call before write.');
  }

  // --- Writing ---
  if (availableTools.has('write')) {
    lines.push(
      '- `write({filePath, content})` or `write({path, content})`: create or fully overwrite a file. Always read the file first. The content field must contain the complete new file contents.'
    );
  }

  if (availableTools.has('edit')) {
    lines.push(
      '- `edit({filePath, startLine, endLine, newText})`: replace lines startLine..endLine (1-based, inclusive) with newText. ' +
        '`edit({filePath, line, operation: "insert_after", newText})`: insert newText after line (0 = prepend). ' +
        'Always read the file first to get exact line numbers. Use write instead if most of the file changes.'
    );
  }

  // --- Execution ---
  if (availableTools.has('bash')) {
    lines.push(
      '- `bash({command})`: run a bash command with captured output. Prefer for validation and bounded inspection, not broad exploration.'
    );
  }
  if (availableTools.has('powershell')) {
    lines.push(
      '- `powershell({command})`: run a PowerShell command with captured output. Prefer for validation and bounded inspection, not broad exploration.'
    );
  }
  if (availableTools.has('monitor')) {
    lines.push('- `monitor({command})`: run a long-running command in the background and stream output to a tracked task.');
  }

  // --- Code intelligence ---
  if (availableTools.has('lsp')) {
    lines.push(
      '- `lsp({action, symbol?})`: code intelligence. action must be one of `definition` | `references` | `diagnostics`. symbol is required for definition and references.'
    );
  }

  // --- Notebooks ---
  if (availableTools.has('notebook-edit')) {
    lines.push(
      '- `notebook-edit({filePath, cellIndex, source})`: replace a Jupyter notebook cell source by zero-based index.'
    );
  }

  // --- Tasks ---
  if (availableTools.has('task-create')) {
    lines.push('- `task-create({title, details?})`: create a new tracked task.');
  }
  if (availableTools.has('task-list')) {
    lines.push('- `task-list({})`: list all tracked tasks.');
  }
  if (availableTools.has('task-get')) {
    lines.push('- `task-get({taskId})`: fetch a tracked task by id.');
  }
  if (availableTools.has('task-update')) {
    lines.push(
      '- `task-update({taskId, title?, details?, status?, outputPath?})`: update a task. status must be one of `pending` | `in_progress` | `completed` | `cancelled` | `failed`.'
    );
  }
  if (availableTools.has('task-output')) {
    lines.push('- `task-output({taskId})`: read the output file for a tracked task.');
  }
  if (availableTools.has('task-stop')) {
    lines.push('- `task-stop({taskId})`: stop a running tracked task.');
  }
  if (availableTools.has('todo-write')) {
    lines.push('- `todo-write({items})`: bulk-create tracked tasks from a string array checklist. items is string[].');
  }

  // --- MCP ---
  if (availableTools.has('list-mcp-resources')) {
    lines.push('- `list-mcp-resources({})`: list all readable resources on the local MCP surface.');
  }
  if (availableTools.has('read-mcp-resource')) {
    lines.push('- `read-mcp-resource({resource})`: read one MCP resource by label or source path.');
  }

  // --- Meta ---
  if (availableTools.has('tool-search')) {
    lines.push('- `tool-search({query})`: discover available tools, skills, and MCP capabilities by keyword.');
  }
  if (availableTools.has('skill')) {
    lines.push('- `skill({skillId, prompt?})`: invoke a skill by id. prompt is an optional user request to combine with the skill.');
  }

  return lines.join('\n');
}

function findLatestUnrecoveredToolFailure(toolInvocations: ToolInvocation[]): ToolInvocation | null {
  let latestFailureIndex = -1;

  for (let index = toolInvocations.length - 1; index >= 0; index -= 1) {
    if (toolInvocations[index]?.status === 'failed') {
      latestFailureIndex = index;
      break;
    }
  }

  if (latestFailureIndex === -1) {
    return null;
  }

  const hasCompletedRecovery = toolInvocations
    .slice(latestFailureIndex + 1)
    .some((invocation) => invocation.status === 'completed');

  return hasCompletedRecovery ? null : (toolInvocations[latestFailureIndex] ?? null);
}

function isEnvironmentBlockedToolFailure(invocation: ToolInvocation): boolean {
  const errorMessage = invocation.errorMessage ?? '';

  return (
    /requires approval/i.test(errorMessage) ||
    /grant it from settings/i.test(errorMessage) ||
    /requires a connected workspace folder/i.test(errorMessage) ||
    /only access the app workspace or the connected workspace folder/i.test(errorMessage)
  );
}

function buildToolFailureRecoveryHint(invocation: ToolInvocation): string[] {
  const errorMessage = invocation.errorMessage ?? '';

  switch (invocation.toolId) {
    case 'edit':
      return [
        '- Read the file first to get exact line numbers, then retry with `{ filePath, startLine, endLine, newText }`.',
        '- If most of the file needs to change, switch to `write` with the full replacement content.'
      ];
    case 'write':
      return [
        '- Call `write` with JSON arguments containing `filePath` or `path` plus full `content`.',
        '- If the target path is uncertain, use `workspace-search`, `glob`, or `workspace-lister` first.'
      ];
    case 'read':
    case 'file-reader':
      return [
        '- Retry with the exact file path or quoted filename.',
        '- If the path is uncertain, use `workspace-search`, `glob`, or `workspace-lister` before retrying.'
      ];
    case 'workspace-search':
    case 'glob':
    case 'workspace-lister':
      return [
        '- Use a broader path, pattern, or query first, then narrow down once the right file is identified.'
      ];
    case 'bash':
    case 'powershell':
      return [
        '- Retry with a bounded inspection or validation command.',
        '- If you only need file contents, prefer `read`, `grep`, or `glob` instead of shell.'
      ];
    default:
      if (/expects/i.test(errorMessage)) {
        return ['- Retry with the exact argument shape named in the error message.'];
      }

      return ['- Retry with corrected arguments or choose a more appropriate tool for the next step.'];
  }
}

function buildMissingToolUseReminder(input: {
  workflowMode: NativeToolWorkflowMode;
  includeRepositoryAnalysisGuidance: boolean;
  toolDefinitions: OllamaToolDefinition[];
}): string {
  const scopeLine = input.includeRepositoryAnalysisGuidance
    ? 'This repository or codebase request must be grounded in tool results from the connected workspace.'
    : input.workflowMode === 'coding'
      ? 'This coding request must inspect, modify, or verify files with tools before it can finish.'
      : 'Use the local tools to inspect workspace state or perform the requested action before you answer.';

  return [
    NATIVE_TOOL_USE_REQUIRED_SYSTEM_PROMPT,
    scopeLine,
    'If the exact path is unknown, start with `workspace-lister`, `workspace-search`, or `glob`.',
    buildNativeToolReferencePrompt(input.toolDefinitions)
  ].join('\n');
}

function buildToolFailureRecoveryReminder(input: {
  failure: ToolInvocation;
  toolDefinitions: OllamaToolDefinition[];
}): string {
  const errorMessage = input.failure.errorMessage?.trim() || 'Unknown tool error.';

  return [
    TOOL_FAILURE_RECOVERY_SYSTEM_PROMPT,
    `Latest failure: \`${input.failure.toolId}\` - ${errorMessage}`,
    'Recovery hints:',
    ...buildToolFailureRecoveryHint(input.failure),
    'Choose the next corrective tool call now.',
    buildNativeToolReferencePrompt(input.toolDefinitions)
  ].join('\n');
}

function hasCompletedToolProgressSince(
  toolInvocations: ToolInvocation[],
  startIndex: number
): boolean {
  return toolInvocations
    .slice(startIndex)
    .some((invocation) => invocation.status === 'completed');
}

function mergeContextSources(...collections: ReadonlyArray<ContextSource[]>): ContextSource[] {
  const merged: ContextSource[] = [];
  const seen = new Set<string>();

  for (const collection of collections) {
    for (const source of collection) {
      if (seen.has(source.id)) {
        continue;
      }

      seen.add(source.id);
      merged.push(source);
    }
  }

  return merged;
}

function isGeneralPurposeRoutingModel(model: string): boolean {
  return !/(vl|vision|llava|coder|code)/i.test(model);
}

function isCloudHostedModel(model: string): boolean {
  return /(?:^|[:/.-])cloud(?:$|[:/.-])|(?:^|[:/.-][A-Za-z0-9]+)-cloud(?:$|[:/.-])/i.test(
    model.trim()
  );
}

function pickRouteAnalysisModel(
  availableModels: string[],
  settings: UserSettings,
  requestedModel?: string
): string | null {
  const normalizedAvailableModels = Array.from(
    new Set(availableModels.map((model) => model.trim()).filter(Boolean))
  );
  const normalizedRequestedModel = requestedModel?.trim();
  const preferredRequestedModel =
    normalizedRequestedModel && isGeneralPurposeRoutingModel(normalizedRequestedModel)
      ? normalizedRequestedModel
      : undefined;
  const candidates = [
    preferredRequestedModel,
    settings.defaultModel.trim() || undefined,
    normalizedAvailableModels.find((model) => isGeneralPurposeRoutingModel(model)),
    normalizedRequestedModel,
    normalizedAvailableModels[0]
  ];

  for (const candidate of candidates) {
    if (candidate && normalizedAvailableModels.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

function parseModelRouteAnalysis(
  value: string,
  allowedToolIds: Set<string>,
  allowedSkillIds: Set<string>
): ModelRouteAnalysis | null {
  const jsonCandidate = extractJsonObject(value);

  if (!jsonCandidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    const rawToolId =
      typeof parsed.toolId === 'string' && allowedToolIds.has(parsed.toolId.trim())
        ? parsed.toolId.trim()
        : null;
    const rawSkillId =
      typeof parsed.skillId === 'string' && allowedSkillIds.has(parsed.skillId.trim())
        ? parsed.skillId.trim()
        : null;
    const rawNeedsVision = typeof parsed.needsVision === 'boolean' ? parsed.needsVision : false;
    const rawPrefersCode = typeof parsed.prefersCode === 'boolean' ? parsed.prefersCode : false;
    const rawUseWorkspaceKnowledge =
      typeof parsed.useWorkspaceKnowledge === 'boolean'
        ? parsed.useWorkspaceKnowledge
        : false;
    const rawImageMode =
      parsed.imageMode === 'none' ||
      parsed.imageMode === 'text-to-image' ||
      parsed.imageMode === 'image-to-image' ||
      parsed.imageMode === 'prompt-authoring'
        ? parsed.imageMode
        : 'none';
    const rawConfidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
    const rawReason =
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? clipRouteAnalysisText(parsed.reason, 160)
        : 'classifier-response';

    return {
      toolId: rawToolId,
      skillId: rawSkillId,
      needsVision: rawNeedsVision,
      prefersCode: rawPrefersCode,
      useWorkspaceKnowledge: rawUseWorkspaceKnowledge,
      imageMode: rawImageMode,
      confidence: rawConfidence,
      reason: rawReason
    };
  } catch {
    return null;
  }
}

function buildRouteAnalysisPrompt(input: {
  prompt: string;
  attachments: MessageAttachment[];
  workspaceHasKnowledge: boolean;
  workspaceRootConnected: boolean;
  recentMessages: StoredMessage[];
  availableToolLines: string[];
  availableSkillLines: string[];
}): string {
  const recentContext =
    input.recentMessages.length === 0
      ? '- None'
      : input.recentMessages
          .slice(-ROUTE_ANALYSIS_RECENT_MESSAGE_LIMIT)
          .map((message) => {
            const routeSummary = message.routeTrace
              ? ` | route=${message.routeTrace.strategy}:${message.routeTrace.reason}`
              : '';

            return `- ${message.role}: ${clipRouteAnalysisText(message.content, ROUTE_ANALYSIS_MESSAGE_CHAR_LIMIT)}${routeSummary}`;
          })
          .join('\n');

  return [
    'Available tools:',
    input.availableToolLines.join('\n'),
    '',
    'Available skills:',
    input.availableSkillLines.join('\n'),
    '',
    `Workspace folder connected: ${input.workspaceRootConnected ? 'yes' : 'no'}`,
    `Workspace has imported knowledge: ${input.workspaceHasKnowledge ? 'yes' : 'no'}`,
    `Current turn has image attachments: ${input.attachments.some(isImageAttachment) ? 'yes' : 'no'}`,
    '',
    'Recent conversation:',
    recentContext,
    '',
    'Latest user prompt:',
    clipRouteAnalysisText(input.prompt, 600)
  ].join('\n');
}

function sanitizeExportPayload(payload: ConversationExportPayload): ConversationExportPayload {
  return conversationExportPayloadSchema.parse({
    conversation: payload.conversation,
    workspace: payload.workspace
      ? {
          ...payload.workspace,
          rootPath: null
        }
      : null,
    messages: payload.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        filePath: null
      }))
    }))
  });
}

function encodeMarkdownPayload(payload: ConversationExportPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function buildMarkdownExport(payload: ConversationExportPayload): string {
  const lines = [
    `# ${payload.conversation.title}`,
    '',
    `- Conversation ID: ${payload.conversation.id}`,
    `- Workspace: ${payload.workspace?.name ?? 'Unassigned'}`,
    `- Created: ${payload.conversation.createdAt}`,
    `- Updated: ${payload.conversation.updatedAt}`,
    '',
    '---',
    ''
  ];

  for (const message of payload.messages) {
    lines.push(`## ${message.role}`);
    lines.push('');
    lines.push(message.content || '_No content_');
    lines.push('');

    if ((message.toolInvocations ?? []).length > 0) {
      lines.push('### Tool traces');
      lines.push('');

      for (const invocation of message.toolInvocations ?? []) {
        lines.push(
          `- ${invocation.displayName}: ${invocation.status} (${invocation.inputSummary})`
        );
      }

      lines.push('');
    }

    if ((message.contextSources ?? []).length > 0) {
      lines.push('### Sources');
      lines.push('');

      for (const source of message.contextSources ?? []) {
        lines.push(`- ${source.label}: ${source.excerpt}`);
      }

      lines.push('');
    }

    if (message.attachments.length > 0) {
      lines.push('### Attachments');
      lines.push('');

      for (const attachment of message.attachments) {
        const attachmentParts = [attachment.fileName];

        if (attachment.mimeType) {
          attachmentParts.push(attachment.mimeType);
        }

        if (attachment.sizeBytes !== null) {
          attachmentParts.push(`${attachment.sizeBytes} bytes`);
        }

        attachmentParts.push(
          attachment.extractedText ? 'text included in import payload' : 'metadata only'
        );
        lines.push(`- ${attachmentParts.join(' | ')}`);
      }

      lines.push('');
    }

    lines.push(`- Status: ${message.status}`);
    lines.push(`- Timestamp: ${message.createdAt}`);
    lines.push('');
  }

  lines.push(`<!-- OLLAMA_DESKTOP_EXPORT:${encodeMarkdownPayload(payload)} -->`);
  return lines.join('\n');
}

function parseLegacyMarkdownExport(markdown: string): ConversationExportPayload {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const title = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Imported conversation';
  const workspaceName =
    normalized.match(/^- Workspace:\s+(.+)$/m)?.[1]?.trim() || 'General';
  const createdAt =
    normalized.match(/^- Created:\s+(.+)$/m)?.[1]?.trim() || new Date().toISOString();
  const updatedAt =
    normalized.match(/^- Updated:\s+(.+)$/m)?.[1]?.trim() || createdAt;
  const conversationId = randomUUID();
  const workspaceId = randomUUID();
  const matches = [...normalized.matchAll(/^##\s+(system|user|assistant)\s*$/gm)];

  const messages = matches.map((match, index) =>
    storedMessageSchema.parse({
      id: randomUUID(),
      conversationId,
      role: match[1],
      content: normalized
        .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? normalized.length)
        .replace(/\n?- Status:\s+(pending|streaming|completed|failed)\s*$/m, '')
        .replace(/\n?- Timestamp:\s+.+\s*$/m, '')
        .trim()
        .replace(/^_No content_$/, ''),
      attachments: [],
      status:
        normalized
          .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? normalized.length)
          .match(/^- Status:\s+(pending|streaming|completed|failed)$/m)?.[1] ?? 'completed',
      model: null,
      correlationId: null,
      createdAt:
        normalized
          .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? normalized.length)
          .match(/^- Timestamp:\s+(.+)$/m)?.[1]?.trim() ?? updatedAt,
      updatedAt:
        normalized
          .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? normalized.length)
          .match(/^- Timestamp:\s+(.+)$/m)?.[1]?.trim() ?? updatedAt,
      pinned: false,
      toolInvocations: [],
      contextSources: [],
      usage: null,
      routeTrace: null
    })
  );

  return conversationExportPayloadSchema.parse({
    conversation: {
      id: conversationId,
      workspaceId,
      title,
      createdAt,
      updatedAt
    },
    workspace: {
      id: workspaceId,
      name: workspaceName === 'Unassigned' ? 'General' : workspaceName,
      prompt: null,
      rootPath: null,
      createdAt,
      updatedAt
    },
    messages
  });
}

function parseConversationImport(contents: string, extension: string): ConversationExportPayload {
  if (extension === '.json') {
    return conversationExportPayloadSchema.parse(JSON.parse(contents) as unknown);
  }

  const embeddedPayloadMatch = contents.match(
    /<!--\s*OLLAMA_DESKTOP_EXPORT:([A-Za-z0-9+/=]+)\s*-->/
  );

  if (embeddedPayloadMatch?.[1]) {
    const decoded = Buffer.from(embeddedPayloadMatch[1], 'base64').toString('utf8');
    return conversationExportPayloadSchema.parse(JSON.parse(decoded) as unknown);
  }

  return parseLegacyMarkdownExport(contents);
}

interface PromptDirectives {
  cleanedPrompt: string;
  explicitSkillId: string | null;
  explicitToolId: string | null;
}

interface ResolvedTurnPlan {
  backend: TextInferenceBackend;
  baseUrl: string;
  apiKey: string | null;
  cleanedPrompt: string;
  thinkMode: OllamaThinkValue | undefined;
  toolExecutionPrompt: string;
  routeDecision: RouteDecision;
  activeSkill: SkillDefinition | null;
  supportsNativeToolLoop: boolean;
  selectedModelSizeBytes: number | null;
}

interface AutomaticGenerationPlan {
  prompt: string;
  mode: GenerationJob['mode'];
  reason: string;
  referenceImages: MessageAttachment[];
}

interface ActiveAssistantTurn {
  abortController: AbortController;
  cancelled: boolean;
}

interface NumCtxBudget {
  numCtx: number;
  mode: 'cloud' | 'local';
  priorConversationTokens: number;
  sessionRemainingTokens: number | null;
  resourceCap: number | null;
}

interface InlineMarkupToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

function extractInlineMarkupToolCalls(content: string): {
  cleanedContent: string;
  toolCalls: InlineMarkupToolCall[];
} {
  const toolCalls: InlineMarkupToolCall[] = [];

  const contentWithoutCalls = content.replace(
    INLINE_TOOL_CALL_SEGMENT_PATTERN,
    (_match, ...rawGroups: unknown[]) => {
      const groups =
        typeof rawGroups.at(-1) === 'object' && rawGroups.at(-1) !== null
          ? (rawGroups.at(-1) as { tool?: string; args?: string })
          : {};
      const toolName = groups.tool?.trim();

      if (!toolName) {
        return '';
      }

      const rawArgs = groups.args?.trim() ?? '';
      toolCalls.push({
        toolName,
        arguments:
          parseJsonishRecord(rawArgs) ??
          (rawArgs ? { __raw: rawArgs } : {})
      });

      return '';
    }
  );

  return {
    cleanedContent: contentWithoutCalls
      .replace(INLINE_TOOL_CALL_WRAPPER_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    toolCalls
  };
}

function buildInlineToolExecutionResultPrompt(toolOutputs: string[]): string {
  return [
    INTERCEPTED_TOOL_CALL_CONTINUATION_SYSTEM_PROMPT,
    'Tool results:',
    ...toolOutputs
  ].join('\n\n');
}

export class ChatService {
  private readonly previewAllowedPaths = new Set<string>();
  private readonly activeAssistantTurns = new Map<string, ActiveAssistantTurn>();

  constructor(
    private readonly repository: ChatRepository,
    private readonly turnMetadataService: TurnMetadataService,
    private readonly settingsService: SettingsService,
    private readonly ollamaClient: OllamaClient,
    private readonly nvidiaClient: NvidiaClient,
    private readonly router: ChatRouter,
    private readonly queue: BridgeQueue,
    private readonly logger: Logger,
    private readonly memoryService: MemoryService,
    private readonly ragService: RagService,
    private readonly toolDispatcher: ToolDispatcher,
    private readonly skillRegistry: SkillRegistry,
    private readonly generationRepository?: GenerationRepository,
    private readonly generationService?: Pick<GenerationService, 'startImageJob'>,
    private readonly readFreeMemoryBytes: () => number = () => os.freemem()
  ) {}

  listConversations() {
    return this.repository.listConversations();
  }

  listWorkspaces() {
    return this.repository.listWorkspaces();
  }

  listMessages(conversationId: string) {
    return this.decorateMessages(this.repository.listMessages(conversationId));
  }

  listTools(): ToolDefinition[] {
    return this.toolDispatcher.listDefinitions();
  }

  listSkills(): SkillDefinition[] {
    return this.skillRegistry.list();
  }

  listKnowledgeDocuments(workspaceId: string): KnowledgeDocument[] {
    return this.ragService.listWorkspaceDocuments(workspaceId);
  }

  deleteConversation(conversationId: string) {
    const conversation = this.repository.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} was not found.`);
    }

    this.repository.deleteConversation(conversationId);
    this.logger.info({ conversationId }, 'Deleted conversation');
  }

  pinMessage(messageId: string, pinned: boolean): StoredMessage {
    const message = this.repository.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} was not found.`);
    }

    this.turnMetadataService.setMessagePinned(message.id, message.conversationId, pinned);
    return this.decorateMessage(message.id);
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    const request = createWorkspaceInputSchema.parse(input);
    const rootPath = request.rootPath
      ? await this.resolveWorkspaceRootPath(request.rootPath)
      : undefined;

    if (rootPath) {
      const existingWorkspace = this.repository.findWorkspaceByRootPath(rootPath);

      if (existingWorkspace) {
        throw new Error(
          `The folder is already connected to workspace "${existingWorkspace.name}".`
        );
      }
    }

    const workspace = this.repository.createWorkspace({
      ...request,
      ...(rootPath ? { rootPath } : {})
    });

    this.logger.info(
      {
        workspaceId: workspace.id,
        name: workspace.name,
        rootPath: workspace.rootPath
      },
      'Created workspace'
    );

    return workspace;
  }

  async updateWorkspaceRoot(input: { workspaceId: string; rootPath: string | null }) {
    const request = updateWorkspaceRootInputSchema.parse(input);
    const workspace = this.repository.getWorkspace(request.workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${request.workspaceId} was not found.`);
    }

    const rootPath =
      request.rootPath === null
        ? null
        : await this.resolveWorkspaceRootPath(request.rootPath);

    if (rootPath) {
      const existingWorkspace = this.repository.findWorkspaceByRootPath(rootPath);

      if (existingWorkspace && existingWorkspace.id !== workspace.id) {
        throw new Error(
          `The folder is already connected to workspace "${existingWorkspace.name}".`
        );
      }
    }

    const updatedWorkspace = this.repository.updateWorkspaceRoot(workspace.id, rootPath);
    this.logger.info(
      {
        workspaceId: updatedWorkspace.id,
        rootPath: updatedWorkspace.rootPath
      },
      'Updated workspace root folder'
    );

    return updatedWorkspace;
  }

  searchConversations(query: string) {
    return this.repository.searchConversations(query);
  }

  async prepareAttachments(filePaths: string[]): Promise<MessageAttachment[]> {
    const uniqueFilePaths = [...new Set(filePaths)];
    const attachments = await Promise.all(
      uniqueFilePaths.map(async (filePath) => {
        const fileStat = await stat(filePath);

        if (!fileStat.isFile()) {
          throw new Error(`Attachment path is not a file: ${filePath}`);
        }

        let extractedText: string | null = null;

        if (canInlineAttachmentText(filePath, fileStat.size)) {
          try {
            extractedText = (await readFile(filePath, 'utf8')).slice(
              0,
              MAX_ATTACHMENT_TEXT_CHARS
            );
          } catch (error) {
            this.logger.warn(
              {
                filePath,
                error: error instanceof Error ? error.message : String(error)
              },
              'Unable to inline attachment text'
            );
          }
        }

        this.previewAllowedPaths.add(path.normalize(filePath));

        return messageAttachmentSchema.parse({
          id: randomUUID(),
          fileName: path.basename(filePath),
          filePath,
          mimeType: inferMimeType(filePath),
          sizeBytes: fileStat.size,
          extractedText,
          createdAt: new Date().toISOString()
        });
      })
    );

    return attachments;
  }

  async getAttachmentPreview(filePath: string) {
    const normalizedPath = path.normalize(filePath);

    if (!this.isKnownLocalFilePath(normalizedPath)) {
      throw new Error('Attachment preview is not permitted for this path.');
    }

    if (!isImageFilePath(normalizedPath)) {
      throw new Error('Only image attachments can be previewed.');
    }

    const fileStat = await stat(normalizedPath);

    if (!fileStat.isFile()) {
      throw new Error(`Attachment path is not a file: ${normalizedPath}`);
    }

    if (fileStat.size > MAX_ATTACHMENT_PREVIEW_BYTES) {
      throw new Error('Attachment preview is too large to load safely.');
    }

    const mimeType = inferMimeType(normalizedPath) ?? 'application/octet-stream';
    const fileBuffer = await readFile(normalizedPath);

    return {
      dataUrl: `data:${mimeType};base64,${fileBuffer.toString('base64')}`,
      mimeType
    };
  }

  async openLocalPath(filePath: string): Promise<string> {
    const normalizedPath = path.normalize(filePath);

    if (!this.isKnownLocalFilePath(normalizedPath)) {
      throw new Error('Opening this local file is not permitted.');
    }

    const fileStat = await stat(normalizedPath);

    if (!fileStat.isFile()) {
      throw new Error(`Local path is not a file: ${normalizedPath}`);
    }

    return normalizedPath;
  }

  importWorkspaceKnowledge(
    workspaceId: string,
    attachments: MessageAttachment[]
  ): ImportWorkspaceKnowledgeResult {
    return importWorkspaceKnowledgeResultSchema.parse({
      workspaceId,
      ...this.ragService.importAttachments(workspaceId, attachments)
    });
  }

  async importConversationFromFile(filePath: string) {
    const contents = await readFile(filePath, 'utf8');
    const payload = parseConversationImport(contents, path.extname(filePath).toLowerCase());
    const imported = this.repository.importConversation(payload);

    return importConversationResultSchema.parse({
      path: filePath,
      conversation: imported.conversation,
      workspace: imported.workspace
    });
  }

  exportConversation(input: { conversationId: string; format: 'markdown' | 'json' }) {
    const request = exportConversationInputSchema.parse(input);
    const exportData = sanitizeExportPayload(
      this.repository.getConversationExport(request.conversationId)
    );

    if (request.format === 'json') {
      return JSON.stringify(exportData, null, 2);
    }

    return buildMarkdownExport(exportData);
  }

  async submitPrompt(
    input: ChatTurnRequest,
    emitEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatStartAccepted> {
    const request = chatTurnRequestSchema.parse(input);
    const conversation =
      request.conversationId === undefined
        ? this.repository.createConversation({
            prompt: request.prompt,
            ...(request.workspaceId ? { workspaceId: request.workspaceId } : {})
          })
        : this.repository.getConversation(request.conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} was not found.`);
    }

    const settings = this.settingsService.get();
    const activeTextBackend = await this.getActiveTextBackendStatus(settings);
    const directives = this.parsePromptDirectives(request.prompt);
    this.logger.info(
      {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        requestedModel: request.model ?? null,
        requestedThinkMode: request.think ?? null,
        explicitSkillId: directives.explicitSkillId,
        explicitToolId: directives.explicitToolId,
        attachmentCount: (request.attachments ?? []).length,
        attachments: summarizeLoggedAttachments(request.attachments ?? []),
        prompt: clipLoggedText(request.prompt),
        cleanedPrompt: clipLoggedText(directives.cleanedPrompt)
      },
      'Received user prompt'
    );
    const recentMessages = this.listMessages(conversation.id);
    const workspaceHasKnowledge = Boolean(
      conversation.workspaceId && this.ragService.hasWorkspaceKnowledge(conversation.workspaceId)
    );
    const modelAnalysis = await this.resolveModelRouteAnalysis({
      prompt: directives.cleanedPrompt,
      requestedModel: request.model,
      attachments: request.attachments ?? [],
      recentMessages,
      workspaceHasKnowledge,
      explicitSkillId: directives.explicitSkillId,
      explicitToolId: directives.explicitToolId,
      settings,
      backend: activeTextBackend.backend,
      baseUrl: activeTextBackend.baseUrl,
      apiKey: activeTextBackend.apiKey,
      availableModels: activeTextBackend.models.map((model) => model.name),
      backendReady: activeTextBackend.ready
    });

    const automaticGenerationPlan = await this.resolveAutomaticGenerationPlan({
      prompt: request.prompt,
      requestedModel: request.model,
      attachments: request.attachments ?? [],
      conversationId: conversation.id,
      modelAnalysis
    });

    if (automaticGenerationPlan) {
      if (!this.generationService) {
        throw new Error('Image generation is not available in this app context.');
      }

      const job = await this.generationService.startImageJob({
        conversationId: conversation.id,
        prompt: automaticGenerationPlan.prompt,
        mode: automaticGenerationPlan.mode,
        referenceImages: automaticGenerationPlan.referenceImages
      });
      const touchedConversation = this.repository.touchConversation(conversation.id);
      const accepted = chatStartAcceptedSchema.parse({
        kind: 'generation',
        requestId: randomUUID(),
        conversation: touchedConversation,
        job,
        model: job.model
      });

      this.logger.info(
        {
          conversationId: touchedConversation.id,
          jobId: job.id,
          mode: job.mode,
          model: job.model,
          reason: automaticGenerationPlan.reason,
          referenceImageCount: automaticGenerationPlan.referenceImages.length
        },
        'Automatically routed prompt to inline image generation'
      );

      return accepted;
    }

    return chatStartAcceptedSchema.parse({
      kind: 'chat',
      ...(await this.startChatTurnInternal(
        {
          ...request,
          conversationId: conversation.id
        },
        conversation,
        emitEvent,
        modelAnalysis
      ))
    });
  }

  async startChatTurn(
    input: ChatTurnRequest,
    emitEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatTurnAccepted> {
    const request = chatTurnRequestSchema.parse(input);
    const conversation =
      request.conversationId === undefined
        ? this.repository.createConversation({
            prompt: request.prompt,
            ...(request.workspaceId ? { workspaceId: request.workspaceId } : {})
          })
        : this.repository.getConversation(request.conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} was not found.`);
    }

    return this.startChatTurnInternal(request, conversation, emitEvent);
  }

  private async startChatTurnInternal(
    request: ChatTurnRequest,
    conversation: NonNullable<ReturnType<ChatRepository['getConversation']>>,
    emitEvent: (event: ChatStreamEvent) => void,
    modelAnalysis?: ModelRouteAnalysis | null
  ): Promise<ChatTurnAccepted> {
    const parsedRequest = chatTurnRequestSchema.parse(request);

    const importedKnowledge = conversation.workspaceId
      ? this.importWorkspaceKnowledge(
          conversation.workspaceId,
          parsedRequest.attachments ?? []
        )
      : null;
    const routePlan = await this.resolveTurnPlan({
      prompt: parsedRequest.prompt,
      requestedModel: parsedRequest.model,
      requestedThinkMode: parsedRequest.think,
      attachments: parsedRequest.attachments ?? [],
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      importedKnowledge,
      modelAnalysis
    });
    const correlationId = randomUUID();
    const userMessage = this.repository.createMessage({
      conversationId: conversation.id,
      role: 'user',
      content: parsedRequest.prompt,
      attachments: parsedRequest.attachments ?? [],
      status: 'completed',
      correlationId,
      model:
        routePlan.routeDecision.selectedModel ??
        `builtin:${routePlan.routeDecision.activeToolId}`
    });

    this.logger.info(
      {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        userMessageId: userMessage.id,
        requestedThinkMode: parsedRequest.think ?? null,
        importedKnowledgeCount: importedKnowledge?.documents.length ?? 0,
        attachmentCount: userMessage.attachments.length,
        attachments: summarizeLoggedAttachments(userMessage.attachments),
        prompt: clipLoggedText(userMessage.content)
      },
      'Persisted user message for assistant turn'
    );

    return this.beginAssistantTurn({
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      routePlan,
      emitEvent
    });
  }

  async editMessageAndResend(
    input: EditMessageInput,
    emitEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatTurnAccepted> {
    const request = editMessageInputSchema.parse(input);
    const targetMessage = this.repository.getMessage(request.messageId);

    if (!targetMessage) {
      throw new Error(`Message ${request.messageId} was not found.`);
    }

    if (targetMessage.role !== 'user') {
      throw new Error('Only user messages can be edited and resent.');
    }

    const conversation = this.repository.getConversation(targetMessage.conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${targetMessage.conversationId} was not found.`);
    }

    this.repository.deleteMessagesAfter(targetMessage.id);
    const importedKnowledge = conversation.workspaceId
      ? this.importWorkspaceKnowledge(conversation.workspaceId, request.attachments ?? [])
      : null;
    const routePlan = await this.resolveTurnPlan({
      prompt: request.prompt,
      requestedModel: request.model,
      requestedThinkMode: request.think,
      attachments: request.attachments ?? [],
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      importedKnowledge,
      excludeMessageIds: [targetMessage.id]
    });
    const userMessage = this.repository.updateMessage(targetMessage.id, {
      content: request.prompt,
      attachments: request.attachments ?? [],
      status: 'completed',
      model:
        routePlan.routeDecision.selectedModel ??
        `builtin:${routePlan.routeDecision.activeToolId}`
    });

    this.logger.info(
      {
        conversationId: userMessage.conversationId,
        userMessageId: userMessage.id,
        requestedModel: request.model ?? null,
        requestedThinkMode: request.think ?? null,
        attachmentCount: userMessage.attachments.length,
        attachments: summarizeLoggedAttachments(userMessage.attachments),
        prompt: clipLoggedText(userMessage.content)
      },
      'Edited user message and restarted assistant turn'
    );

    return this.beginAssistantTurn({
      conversationId: userMessage.conversationId,
      userMessageId: userMessage.id,
      routePlan,
      emitEvent
    });
  }

  async regenerateResponse(
    input: RegenerateResponseInput,
    emitEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatTurnAccepted> {
    const request = regenerateResponseInputSchema.parse(input);
    const assistantMessage = this.decorateMessage(request.assistantMessageId);

    if (!assistantMessage) {
      throw new Error(`Message ${request.assistantMessageId} was not found.`);
    }

    if (assistantMessage.role !== 'assistant') {
      throw new Error('Only assistant messages can be regenerated.');
    }

    const messages = this.listMessages(assistantMessage.conversationId);
    const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
    const userMessage = [...messages.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === 'user');

    if (!userMessage) {
      throw new Error('No preceding user message was found for regeneration.');
    }

    this.repository.deleteMessagesAfter(assistantMessage.id, { includeTarget: true });
    const routePlan = await this.resolveTurnPlan({
      prompt: userMessage.content,
      requestedModel: request.model,
      requestedThinkMode: request.think,
      attachments: userMessage.attachments ?? [],
      conversationId: assistantMessage.conversationId,
      workspaceId:
        this.repository.getConversation(assistantMessage.conversationId)?.workspaceId ?? null,
      importedKnowledge: null,
      excludeMessageIds: [userMessage.id]
    });

    this.logger.info(
      {
        conversationId: assistantMessage.conversationId,
        assistantMessageId: assistantMessage.id,
        userMessageId: userMessage.id,
        requestedModel: request.model ?? null,
        requestedThinkMode: request.think ?? null,
        prompt: clipLoggedText(userMessage.content)
      },
      'Regenerating assistant response'
    );

    return this.beginAssistantTurn({
      conversationId: assistantMessage.conversationId,
      userMessageId: userMessage.id,
      routePlan,
      emitEvent
    });
  }

  cancelChatTurn(input: CancelChatTurnInput): void {
    const request = cancelChatTurnInputSchema.parse(input);
    const message = this.repository.getMessage(request.assistantMessageId);

    if (!message) {
      throw new Error(`Message ${request.assistantMessageId} was not found.`);
    }

    if (message.role !== 'assistant') {
      throw new Error('Only assistant turns can be cancelled.');
    }

    const activeTurn = this.activeAssistantTurns.get(message.id);

    if (!activeTurn) {
      if (message.status !== 'streaming') {
        return;
      }

      throw new Error('This assistant turn is no longer running.');
    }

    if (activeTurn.cancelled) {
      return;
    }

    activeTurn.cancelled = true;
    activeTurn.abortController.abort();
    this.logger.info(
      { assistantMessageId: message.id },
      'Cancellation requested for assistant turn'
    );
  }

  private async getActiveTextBackendStatus(settings: UserSettings): Promise<{
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    ready: boolean;
    error: string | null;
    models: Array<{
      name: string;
      size: number | null;
      digest: string | null;
    }>;
  }> {
    if (settings.textInferenceBackend === 'nvidia') {
      const status = await this.nvidiaClient.getStatus(
        settings.nvidiaBaseUrl,
        settings.nvidiaApiKey
      );

      return {
        backend: 'nvidia',
        baseUrl: settings.nvidiaBaseUrl,
        apiKey: settings.nvidiaApiKey.trim() || null,
        ready: status.configured,
        error: status.error,
        models: status.models
      };
    }

    const status = await this.ollamaClient.getStatus(settings.ollamaBaseUrl);

    return {
      backend: 'ollama',
      baseUrl: settings.ollamaBaseUrl,
      apiKey: null,
      ready: status.reachable,
      error: status.error,
      models: status.models
    };
  }

  private async completeTextChat(input: {
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: OllamaChatMessage[];
    signal?: AbortSignal;
  }): Promise<OllamaChatCompletion> {
    if (input.backend === 'nvidia') {
      return this.nvidiaClient.completeChat({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey ?? '',
        model: input.model,
        messages: input.messages,
        ...(input.signal ? { signal: input.signal } : {})
      });
    }

    return this.ollamaClient.completeChat({
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  private async streamTextChat(input: {
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: OllamaChatMessage[];
    onDelta: (delta: string) => void;
    signal?: AbortSignal;
    think?: OllamaThinkValue;
    numCtx?: number;
  }): Promise<OllamaChatCompletion> {
    if (input.backend === 'nvidia') {
      return this.nvidiaClient.streamChat({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey ?? '',
        model: input.model,
        messages: input.messages,
        onDelta: input.onDelta,
        ...(input.signal ? { signal: input.signal } : {})
      });
    }

    return this.ollamaClient.streamChat({
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      onDelta: input.onDelta,
      ...(input.numCtx === undefined ? {} : { numCtx: input.numCtx }),
      ...(input.think === undefined ? {} : { think: input.think }),
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  private async resolveModelRouteAnalysis(input: {
    prompt: string;
    requestedModel?: string | undefined;
    attachments: MessageAttachment[];
    recentMessages: StoredMessage[];
    workspaceHasKnowledge: boolean;
    workspaceRootConnected?: boolean;
    explicitSkillId: string | null;
    explicitToolId: string | null;
    settings: UserSettings;
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    availableModels: string[];
    backendReady: boolean;
  }): Promise<ModelRouteAnalysis | null> {
    if (input.explicitSkillId || input.explicitToolId || !input.backendReady) {
      return null;
    }

    const routeAnalysisModel = pickRouteAnalysisModel(
      input.availableModels,
      input.settings,
      input.requestedModel
    );

    if (!routeAnalysisModel) {
      return null;
    }

    const availableTools = this.toolDispatcher
      .listDefinitions()
      .filter((tool) => tool.autoRoutable && tool.availability === 'available');
    const availableSkills = this.skillRegistry.list();

    try {
      const completion = await this.completeTextChat({
        backend: input.backend,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: routeAnalysisModel,
        messages: [
          {
            role: 'system',
            content: ROUTE_ANALYSIS_SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: buildRouteAnalysisPrompt({
              prompt: input.prompt,
              attachments: input.attachments,
              workspaceHasKnowledge: input.workspaceHasKnowledge,
              workspaceRootConnected: input.workspaceRootConnected ?? false,
              recentMessages: input.recentMessages,
              availableToolLines: availableTools.map(
                (tool) => `- ${tool.id}: ${tool.description}`
              ),
              availableSkillLines: availableSkills.map(
                (skill) => `- ${skill.id}: ${skill.description}`
              )
            })
          }
        ]
      });
      const analysis = parseModelRouteAnalysis(
        completion.content,
        new Set(availableTools.map((tool) => tool.id)),
        new Set(availableSkills.map((skill) => skill.id))
      );

      if (!analysis) {
        this.logger.warn(
          {
            classifierModel: routeAnalysisModel,
            prompt: clipRouteAnalysisText(input.prompt, 120),
            rawResponse: clipRouteAnalysisText(completion.content, 240)
          },
          'Unable to parse model-assisted route analysis; falling back to heuristics'
        );

        return null;
      }

      this.logger.info(
        {
          classifierModel: routeAnalysisModel,
          confidence: analysis.confidence,
          toolId: analysis.toolId,
          skillId: analysis.skillId,
          imageMode: analysis.imageMode,
          needsVision: analysis.needsVision,
          prefersCode: analysis.prefersCode,
          useWorkspaceKnowledge: analysis.useWorkspaceKnowledge,
          classifierReason: analysis.reason
        },
        'Resolved model-assisted route analysis'
      );

      return analysis;
    } catch (error) {
      this.logger.warn(
        {
          classifierModel: routeAnalysisModel,
          prompt: clipRouteAnalysisText(input.prompt, 120),
          error: error instanceof Error ? error.message : String(error)
        },
        'Model-assisted route analysis failed; falling back to heuristics'
      );

      return null;
    }
  }

  private async resolveAutomaticGenerationPlan(input: {
    prompt: string;
    requestedModel?: string | undefined;
    attachments: MessageAttachment[];
    conversationId: string;
    modelAnalysis?: ModelRouteAnalysis | null;
  }): Promise<AutomaticGenerationPlan | null> {
    if (!this.generationRepository || !this.generationService) {
      return null;
    }

    const settings = this.settingsService.get();

    if (!settings.imageGenerationModel.trim()) {
      return null;
    }

    const directives = this.parsePromptDirectives(input.prompt);

    if (directives.explicitSkillId || directives.explicitToolId) {
      return null;
    }

    const cleanedPrompt = directives.cleanedPrompt;
    const trustedModelAnalysis = isTrustedModelRouteAnalysis(input.modelAnalysis)
      ? input.modelAnalysis
      : null;

    if (
      looksLikeImagePromptAuthoringRequest(cleanedPrompt) ||
      trustedModelAnalysis?.imageMode === 'prompt-authoring'
    ) {
      return null;
    }

    const currentReferenceImages = input.attachments.filter(isImageAttachment);
    const wantsRestoreToPriorImageContext = looksLikeImageRestorePrompt(cleanedPrompt);

    if (currentReferenceImages.length > 0) {
      const explicitImageEdit =
        trustedModelAnalysis?.imageMode === 'image-to-image' ||
        (trustedModelAnalysis === null &&
          (looksLikeImageEditPrompt(cleanedPrompt) || looksLikeTextToImagePrompt(cleanedPrompt)));

      if (
        trustedModelAnalysis?.imageMode === 'none' ||
        looksLikeImageAnalysisPrompt(cleanedPrompt) ||
        !explicitImageEdit
      ) {
        return null;
      }

      const recentMessages = wantsRestoreToPriorImageContext
        ? this.listMessages(input.conversationId)
        : [];
      const recentGenerationJobs = wantsRestoreToPriorImageContext
        ? this.generationRepository.listJobs({
            conversationId: input.conversationId,
            limit: 6
          })
        : [];
      const supplementalReferenceImages = wantsRestoreToPriorImageContext
        ? this.collectPriorImageContextAttachments({
            recentMessages,
            recentGenerationJobs,
            excludeAttachments: currentReferenceImages,
            limit: 2
          })
        : [];
      const referenceImages =
        supplementalReferenceImages.length > 0
          ? mergeDistinctImageAttachments([currentReferenceImages, supplementalReferenceImages], 3)
          : currentReferenceImages;

      return {
        prompt:
          supplementalReferenceImages.length > 0
            ? buildRestoreImageEditPrompt(cleanedPrompt)
            : cleanedPrompt,
        mode: 'image-to-image',
        reason:
          supplementalReferenceImages.length > 0
            ? 'current-image-attachments-contextual-auto-edit'
            : 'current-image-attachments-auto-edit',
        referenceImages
      };
    }

    const recentMessages = this.listMessages(input.conversationId);
    const latestMessageReferenceImages = this.findLatestImageAttachments(recentMessages);
    const recentGenerationJobs = this.generationRepository.listJobs({
      conversationId: input.conversationId,
      limit: 6
    });
    const latestGenerationReferenceImages =
      await this.buildLatestGenerationReferenceImages(recentGenerationJobs);
    const promptRetriesLastImageJob = IMAGE_RETRY_PATTERN.test(cleanedPrompt);
    const canUsePriorImageContext =
      latestGenerationReferenceImages.length > 0 || latestMessageReferenceImages.length > 0;

    if (promptRetriesLastImageJob && latestGenerationReferenceImages.length > 0) {
      const latestGenerationPrompt = recentGenerationJobs[0]?.prompt?.trim();

      if (latestGenerationPrompt) {
        return {
          prompt: latestGenerationPrompt,
          mode: 'image-to-image',
          reason: 'follow-up-image-generation-retry',
          referenceImages: latestGenerationReferenceImages
        };
      }
    }

    if (
      canUsePriorImageContext &&
      !looksLikeImageAnalysisPrompt(cleanedPrompt) &&
      (trustedModelAnalysis?.imageMode === 'image-to-image' ||
        (trustedModelAnalysis === null && looksLikeImageFollowUpPrompt(cleanedPrompt)))
    ) {
      const baseReferenceImages =
        latestGenerationReferenceImages.length > 0
          ? latestGenerationReferenceImages
          : latestMessageReferenceImages;
      const supplementalReferenceImages = wantsRestoreToPriorImageContext
        ? this.collectPriorImageContextAttachments({
            recentMessages,
            recentGenerationJobs,
            excludeAttachments: baseReferenceImages,
            limit: 2
          })
        : [];
      const referenceImages =
        supplementalReferenceImages.length > 0
          ? mergeDistinctImageAttachments([baseReferenceImages, supplementalReferenceImages], 3)
          : baseReferenceImages;

      if (referenceImages.length > 0) {
        return {
          prompt:
            supplementalReferenceImages.length > 0
              ? buildRestoreImageEditPrompt(cleanedPrompt)
              : cleanedPrompt,
          mode: 'image-to-image',
          reason:
            supplementalReferenceImages.length > 0
              ? 'follow-up-restored-image-edit'
              : latestGenerationReferenceImages.length > 0
                ? 'follow-up-generated-image-edit'
                : 'follow-up-attached-image-edit',
          referenceImages
        };
      }
    }

    if (
      trustedModelAnalysis?.imageMode === 'text-to-image' ||
      (trustedModelAnalysis === null && looksLikeTextToImagePrompt(cleanedPrompt))
    ) {
      return {
        prompt: cleanedPrompt,
        mode: 'text-to-image',
        reason:
          trustedModelAnalysis?.imageMode === 'text-to-image'
            ? 'model-text-to-image-auto-generation'
            : 'text-to-image-auto-generation',
        referenceImages: []
      };
    }

    return null;
  }

  private async resolveTurnPlan(input: {
    prompt: string;
    requestedModel?: string | undefined;
    requestedThinkMode?: OllamaThinkMode | undefined;
    attachments: MessageAttachment[];
    conversationId: string;
    workspaceId: string | null;
    importedKnowledge: ImportWorkspaceKnowledgeResult | null;
    excludeMessageIds?: string[];
    modelAnalysis?: ModelRouteAnalysis | null | undefined;
  }): Promise<ResolvedTurnPlan> {
    const directives = this.parsePromptDirectives(input.prompt);
    const settings = this.settingsService.get();
    const activeTextBackend = await this.getActiveTextBackendStatus(settings);
    const workspace =
      input.workspaceId === null ? null : this.repository.getWorkspace(input.workspaceId);
    const recentMessages = this.listMessages(input.conversationId).filter(
      (message) => !(input.excludeMessageIds ?? []).includes(message.id)
    );
    const workspaceHasKnowledge =
      Boolean(input.workspaceId && this.ragService.hasWorkspaceKnowledge(input.workspaceId)) ||
      Boolean(input.importedKnowledge && input.importedKnowledge.documents.length > 0);
    const workspaceRootConnected = Boolean(workspace?.rootPath);
    const modelAnalysis =
      input.modelAnalysis ??
      (await this.resolveModelRouteAnalysis({
        prompt: directives.cleanedPrompt,
        requestedModel: input.requestedModel,
        attachments: input.attachments,
        recentMessages,
        workspaceHasKnowledge,
        workspaceRootConnected,
        explicitSkillId: directives.explicitSkillId,
        explicitToolId: directives.explicitToolId,
        settings,
        backend: activeTextBackend.backend,
        baseUrl: activeTextBackend.baseUrl,
        apiKey: activeTextBackend.apiKey,
        availableModels: activeTextBackend.models.map((model) => model.name),
        backendReady: activeTextBackend.ready
      }));

    if (
      activeTextBackend.backend === 'nvidia' &&
      input.attachments.some(isImageAttachment)
    ) {
      throw new Error(
        'NVIDIA text chat is enabled, but image attachment analysis still requires the Ollama backend in this build.'
      );
    }

    const routeInput: RouteInput = {
      prompt: directives.cleanedPrompt,
      requestedModel: input.requestedModel,
      attachments: input.attachments,
      recentMessages,
      workspaceHasKnowledge,
      explicitSkillId: directives.explicitSkillId,
      explicitToolId: directives.explicitToolId,
      modelAnalysis
    };
    if (!activeTextBackend.ready) {
      throw new Error(
        activeTextBackend.error ??
          (activeTextBackend.backend === 'ollama'
            ? 'Ollama is not running or not reachable. Start Ollama and try again, or check the base URL in Settings.'
            : 'NVIDIA backend is not reachable. Check the base URL and API key in Settings.')
      );
    }

    const routeDecision = this.router.decide(
      routeInput,
      settings,
      activeTextBackend.models.map((model) => model.name)
    );

    if (routeDecision.selectedModel && !activeTextBackend.ready) {
      throw new Error(
        activeTextBackend.error ??
          (activeTextBackend.backend === 'ollama'
            ? 'Ollama is unavailable.'
            : 'NVIDIA is unavailable.')
      );
    }

    return {
      backend: activeTextBackend.backend,
      baseUrl: activeTextBackend.baseUrl,
      apiKey: activeTextBackend.apiKey,
      cleanedPrompt: directives.cleanedPrompt,
      thinkMode:
        activeTextBackend.backend === 'ollama'
          ? resolveOllamaThinkValue(input.requestedThinkMode)
          : undefined,
      toolExecutionPrompt: this.resolveToolExecutionPrompt({
        cleanedPrompt: directives.cleanedPrompt,
        routeDecision,
        recentMessages
      }),
      routeDecision,
      activeSkill:
        routeDecision.activeSkillId === null
          ? null
          : this.skillRegistry.getById(routeDecision.activeSkillId),
      supportsNativeToolLoop: activeTextBackend.backend === 'ollama',
      selectedModelSizeBytes:
        activeTextBackend.backend !== 'ollama' || routeDecision.selectedModel === null
          ? null
          : (activeTextBackend.models.find((model) => model.name === routeDecision.selectedModel)?.size ??
            null)
    };
  }

  private resolveNumCtxBudget(input: {
    model: string;
    promptTokens: number;
    conversationId: string;
    modelSizeBytes: number | null;
    priorConversationTokenTotal?: number;
  }): NumCtxBudget {
    const promptTokens = Math.max(1, input.promptTokens);
    const priorConversationTokens =
      input.priorConversationTokenTotal ??
      this.turnMetadataService.getConversationUsageTotals(input.conversationId).totalTokens;

    if (isCloudHostedModel(input.model)) {
      const basePromptBudget = Math.min(
        CLOUD_NUM_CTX_LIMIT,
        Math.max(MIN_DYNAMIC_NUM_CTX, promptTokens)
      );
      const targetHeadroom = Math.max(
        CLOUD_NUM_CTX_MIN_HEADROOM,
        Math.ceil(promptTokens * 0.25)
      );
      const sessionRemainingTokens = Math.max(
        0,
        CLOUD_SESSION_TOKEN_LIMIT - priorConversationTokens
      );
      const cappedWindow = Math.min(
        CLOUD_NUM_CTX_LIMIT,
        Math.max(basePromptBudget, sessionRemainingTokens)
      );
      const appliedHeadroom = Math.max(
        0,
        Math.min(targetHeadroom, Math.max(cappedWindow - basePromptBudget, 0))
      );

      return {
        numCtx: Math.min(CLOUD_NUM_CTX_LIMIT, basePromptBudget + appliedHeadroom),
        mode: 'cloud',
        priorConversationTokens,
        sessionRemainingTokens,
        resourceCap: CLOUD_NUM_CTX_LIMIT
      };
    }

    const basePromptBudget = Math.max(MIN_DYNAMIC_NUM_CTX, promptTokens);
    const targetHeadroom = Math.max(
      LOCAL_NUM_CTX_MIN_HEADROOM,
      Math.ceil(promptTokens * 0.2)
    );
    const freeBytes = Math.max(
      0,
      this.readFreeMemoryBytes() - LOCAL_NUM_CTX_SYSTEM_HEADROOM_BYTES
    );
    const freeMemoryCap = Math.floor(freeBytes / LOCAL_NUM_CTX_BYTES_PER_TOKEN);
    const modelPenaltyTokens =
      input.modelSizeBytes === null
        ? 0
        : Math.ceil(input.modelSizeBytes / BYTES_PER_GIB) * LOCAL_NUM_CTX_MODEL_PENALTY_PER_GIB;
    const resourceCap = Math.max(
      MIN_DYNAMIC_NUM_CTX,
      Math.min(LOCAL_NUM_CTX_MAX, freeMemoryCap - modelPenaltyTokens)
    );
    const appliedHeadroom = Math.max(
      0,
      Math.min(targetHeadroom, Math.max(resourceCap - Math.min(basePromptBudget, resourceCap), 0))
    );

    return {
      numCtx: basePromptBudget + appliedHeadroom,
      mode: 'local',
      priorConversationTokens,
      sessionRemainingTokens: null,
      resourceCap
    };
  }

  private beginAssistantTurn(input: {
    conversationId: string;
    userMessageId: string;
    routePlan: ResolvedTurnPlan;
    emitEvent: (event: ChatStreamEvent) => void;
  }): ChatTurnAccepted {
    const userMessage = this.decorateMessage(input.userMessageId);

    if (!userMessage) {
      throw new Error(`Message ${input.userMessageId} was not found.`);
    }

    const routeModelLabel =
      input.routePlan.routeDecision.selectedModel ??
      `builtin:${input.routePlan.routeDecision.activeToolId ?? 'tool'}`;
    const correlationId = userMessage.correlationId ?? randomUUID();
    const assistantMessage = this.repository.createMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      content: '',
      attachments: [],
      status: 'streaming',
      correlationId,
      model: routeModelLabel
    });
    const accepted = chatTurnAcceptedSchema.parse({
      requestId: randomUUID(),
      conversation: this.repository.touchConversation(input.conversationId),
      userMessage,
      assistantMessage: this.decorateMessage(assistantMessage.id) ?? assistantMessage,
      model: routeModelLabel
    });

    this.logger.info(
      {
        requestId: accepted.requestId,
        conversationId: accepted.conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: accepted.assistantMessage.id,
        strategy: input.routePlan.routeDecision.strategy,
        reason: input.routePlan.routeDecision.reason,
        activeSkillId: input.routePlan.routeDecision.activeSkillId,
        activeToolId: input.routePlan.routeDecision.activeToolId,
        selectedModel: input.routePlan.routeDecision.selectedModel,
        fallbackModel: input.routePlan.routeDecision.fallbackModel,
        thinkMode: input.routePlan.thinkMode ?? null,
        prompt: clipLoggedText(userMessage.content),
        toolExecutionPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt),
        attachmentCount: userMessage.attachments.length,
        attachments: summarizeLoggedAttachments(userMessage.attachments)
      },
      'Accepted routed assistant turn'
    );

    if (input.routePlan.routeDecision.strategy === 'tool') {
      void this.runDirectToolTurn({
        accepted,
        routePlan: input.routePlan,
        emitEvent: input.emitEvent
      });
    } else {
      void this.runAssistantTurn({
        accepted,
        routePlan: input.routePlan,
        emitEvent: input.emitEvent
      });
    }

    return accepted;
  }

  private async runDirectToolTurn(input: {
    accepted: ChatTurnAccepted;
    routePlan: ResolvedTurnPlan;
    emitEvent: (event: ChatStreamEvent) => void;
  }): Promise<void> {
    const activeToolId = input.routePlan.routeDecision.activeToolId;
    const conversation = this.repository.getConversation(input.accepted.conversation.id);
    const workspace =
      conversation?.workspaceId === null || !conversation?.workspaceId
        ? null
        : this.repository.getWorkspace(conversation.workspaceId);

    if (!activeToolId) {
      throw new Error('A direct tool turn requires an active tool id.');
    }

    this.logger.info(
      {
        requestId: input.accepted.requestId,
        conversationId: input.accepted.conversation.id,
        assistantMessageId: input.accepted.assistantMessage.id,
        toolId: activeToolId,
        workspaceId: workspace?.id ?? null,
        workspaceRootPath: workspace?.rootPath ?? null,
        toolPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt)
      },
      'Starting direct tool turn'
    );

    try {
      const result = await this.toolDispatcher.execute({
        toolId: activeToolId,
        prompt: input.routePlan.toolExecutionPrompt,
        workspaceRootPath: workspace?.rootPath ?? null,
        workspaceId: workspace?.id ?? null,
        conversationId: input.accepted.conversation.id
      });
      const routeTrace = this.createRouteTrace(input.routePlan.routeDecision, {
        usedWorkspacePrompt: false,
        usedPinnedMessages: false,
        usedRag: false,
        usedTools: true
      });
      const usage = this.createUsageEstimate(
        input.routePlan.toolExecutionPrompt,
        result.assistantContent
      );

      this.repository.updateMessage(input.accepted.assistantMessage.id, {
        content: result.assistantContent,
        status: 'completed',
        model: input.accepted.model
      });
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: input.accepted.assistantMessage.id,
        routeTrace,
        usage,
        toolInvocations: result.toolInvocations,
        contextSources: result.contextSources
      });
      this.emitAssistantCompleteEvent({
        emitEvent: input.emitEvent,
        requestId: input.accepted.requestId,
        assistantMessageId: input.accepted.assistantMessage.id,
        content: result.assistantContent,
        doneReason: 'tool-complete',
        model: input.accepted.model,
        routeTrace,
        toolInvocations: result.toolInvocations,
        contextSources: result.contextSources,
        usage
      });

      this.logger.info(
        {
          requestId: input.accepted.requestId,
          conversationId: input.accepted.conversation.id,
          assistantMessageId: input.accepted.assistantMessage.id,
          toolId: activeToolId,
          toolInvocations: summarizeLoggedToolInvocations(result.toolInvocations),
          contextSourceCount: result.contextSources.length,
          assistantContent: clipLoggedText(result.assistantContent)
        },
        'Completed direct tool turn'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      const failedInvocation = this.turnMetadataService.createToolInvocation({
        toolId: activeToolId,
        displayName: this.toolDispatcher.getById(activeToolId)?.title ?? activeToolId,
        status: 'failed',
        inputSummary: input.routePlan.toolExecutionPrompt,
        outputSummary: null,
        outputText: `Tool execution failed.\nError: ${message}`,
        errorMessage: message
      });

      this.repository.updateMessage(input.accepted.assistantMessage.id, {
        content: '',
        status: 'failed',
        model: input.accepted.model
      });
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: input.accepted.assistantMessage.id,
        routeTrace: this.createRouteTrace(input.routePlan.routeDecision, {
          usedWorkspacePrompt: false,
          usedPinnedMessages: false,
          usedRag: false,
          usedTools: true
        }),
        usage: null,
        toolInvocations: [failedInvocation],
        contextSources: []
      });
      input.emitEvent({
        type: 'error',
        requestId: input.accepted.requestId,
        assistantMessageId: input.accepted.assistantMessage.id,
        message,
        recoverable: true
      });

      this.logger.error(
        {
          requestId: input.accepted.requestId,
          conversationId: input.accepted.conversation.id,
          assistantMessageId: input.accepted.assistantMessage.id,
          toolId: activeToolId,
          toolPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt),
          error: message
        },
        'Direct tool turn failed'
      );
    }
  }

  private async runAssistantTurn(input: {
    accepted: ChatTurnAccepted;
    routePlan: ResolvedTurnPlan;
    emitEvent: (event: ChatStreamEvent) => void;
  }): Promise<void> {
    const { accepted } = input;
    const decoratedHistory = this.listMessages(accepted.conversation.id).filter(
      (message) => message.id !== accepted.assistantMessage.id
    );
    const conversation = this.repository.getConversation(accepted.conversation.id);
    const workspace =
      conversation?.workspaceId === null || !conversation?.workspaceId
        ? null
        : this.repository.getWorkspace(conversation.workspaceId);
    const pinnedMessages = this.memoryService.listPinnedMessages(accepted.conversation.id);
    const memoryContext = this.memoryService.buildConversationMemoryContext(
      accepted.conversation.id,
      decoratedHistory
    );
    const ragSources =
      input.routePlan.routeDecision.useRag && conversation?.workspaceId
        ? this.ragService.searchWorkspaceKnowledge(
            conversation.workspaceId,
            input.routePlan.cleanedPrompt,
            4
          )
        : [];
    let toolInvocations: ToolInvocation[] = [];
    let toolContextSources: ContextSource[] = [];
    let toolContextPrompt: string | null = null;

    if (
      input.routePlan.routeDecision.activeToolId &&
      (input.routePlan.routeDecision.strategy === 'tool-chat' ||
        input.routePlan.routeDecision.strategy === 'rag-tool')
    ) {
      try {
        const toolResult = await this.toolDispatcher.execute({
          toolId: input.routePlan.routeDecision.activeToolId,
          prompt: input.routePlan.toolExecutionPrompt,
          workspaceRootPath: workspace?.rootPath ?? null,
          workspaceId: workspace?.id ?? null,
          conversationId: accepted.conversation.id
        });

        toolInvocations = toolResult.toolInvocations;
        toolContextSources = toolResult.contextSources;
        toolContextPrompt = `Tool result:\n${toolResult.assistantContent}`;

        this.logger.info(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: accepted.assistantMessage.id,
            toolId: input.routePlan.routeDecision.activeToolId,
            toolPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt),
            toolInvocations: summarizeLoggedToolInvocations(toolResult.toolInvocations),
            contextSourceCount: toolResult.contextSources.length,
            assistantContent: clipLoggedText(toolResult.assistantContent)
          },
          'Executed bridge tool before assistant response'
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Tool execution failed.';

        toolInvocations = [
          this.turnMetadataService.createToolInvocation({
            toolId: input.routePlan.routeDecision.activeToolId,
            displayName:
              this.toolDispatcher.getById(input.routePlan.routeDecision.activeToolId)?.title ??
              input.routePlan.routeDecision.activeToolId,
            status: 'failed',
            inputSummary: input.routePlan.toolExecutionPrompt,
            outputSummary: null,
            outputText: `Tool execution failed.\nError: ${errorMessage}`,
            errorMessage
          })
        ];
        toolContextPrompt = `Tool execution failed and no tool result is available.\nError: ${errorMessage}`;

        this.logger.warn(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: accepted.assistantMessage.id,
            toolId: input.routePlan.routeDecision.activeToolId,
            toolPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt),
            error: errorMessage
          },
          'Bridge tool execution failed before assistant response'
        );
      }
    }

    const context = buildConversationContext({
      recentMessages: memoryContext.recentMessages,
      pinnedMessages,
      retrievedSources: [...ragSources, ...toolContextSources],
      workspacePrompt: workspace?.prompt ?? null,
      workspaceRootPath: workspace?.rootPath ?? null,
      skillPrompt:
        input.routePlan.activeSkill?.prompt && toolContextPrompt
          ? `${input.routePlan.activeSkill.prompt}\n\n${toolContextPrompt}`
          : input.routePlan.activeSkill?.prompt ?? toolContextPrompt,
      planContextPrompt: buildPlanContextPrompt(this.toolDispatcher.getPlanContext(workspace?.id ?? null)),
      availableTools: this.toolDispatcher
        .listDefinitions()
        .filter((tool) => tool.availability === 'available'),
      latestUserPromptOverride: input.routePlan.cleanedPrompt,
      memorySummary: memoryContext.summaryText,
      summarizedMessageIds: memoryContext.summarizedMessageIds,
      excludedRecentMessageCount: memoryContext.excludedMessageCount,
      maxMessages: 20
    });
    let routeTrace = this.createRouteTrace(input.routePlan.routeDecision, {
      usedWorkspacePrompt: context.observability.usedWorkspacePrompt,
      usedPinnedMessages: context.observability.usedPinnedMessages,
      usedRag: context.observability.usedRag,
      usedTools: toolInvocations.length > 0
    });
    const initialUsage: MessageUsage = {
      promptTokens: context.usageEstimate.promptTokens,
      completionTokens: 0,
      totalTokens: context.usageEstimate.promptTokens
    };

    this.turnMetadataService.saveAssistantTurnArtifacts({
      messageId: accepted.assistantMessage.id,
      routeTrace,
      usage: initialUsage,
      toolInvocations,
      contextSources: context.sources
    });
    this.emitAssistantUpdateEvent({
      emitEvent: input.emitEvent,
      requestId: accepted.requestId,
      assistantMessageId: accepted.assistantMessage.id,
      content: '',
      status: 'streaming',
      model: accepted.model,
      routeTrace,
      ...(toolInvocations.length > 0 ? { toolInvocations } : {})
    });

    this.logger.info(
      {
        requestId: accepted.requestId,
        conversationId: accepted.conversation.id,
        workspaceId: workspace?.id ?? null,
        workspaceRootPath: workspace?.rootPath ?? null,
        model: accepted.model,
        thinkMode: input.routePlan.thinkMode ?? null,
        strategy: routeTrace.strategy,
        reason: routeTrace.reason,
        activeSkillId: routeTrace.activeSkillId,
        activeToolId: routeTrace.activeToolId,
        prompt: clipLoggedText(input.routePlan.cleanedPrompt),
        toolExecutionPrompt: clipLoggedText(input.routePlan.toolExecutionPrompt),
        includedMessageIds: context.observability.includedMessageIds,
        includedPinnedMessageIds: context.observability.includedPinnedMessageIds,
        includedSummaryMessageIds: context.observability.includedSummaryMessageIds,
        includedDocumentIds: context.observability.includedDocumentIds,
        excludedCount: context.observability.excludedCount,
        dedupedItemCount: context.observability.dedupedItemCount,
        usedMemorySummary: context.observability.usedMemorySummary
      },
      'Starting routed text-model chat turn'
    );

    let content = '';
    const activeTurn: ActiveAssistantTurn = {
      abortController: new AbortController(),
      cancelled: false
    };
    this.activeAssistantTurns.set(accepted.assistantMessage.id, activeTurn);
    this.queue.increment();

    try {
      if (
        input.routePlan.backend === 'nvidia' &&
        context.messages.some((message) => message.imageAttachments.length > 0)
      ) {
        throw new Error(
          'NVIDIA text chat is enabled, but image attachments in the conversation context still require the Ollama backend in this build.'
        );
      }

      const ollamaMessages = await Promise.all(
        context.messages.map(async (message) => {
          const images = await Promise.all(
            message.imageAttachments
              .filter((attachment) => attachment.filePath)
              .map(async (attachment) => {
                try {
                  const fileBuffer = await readFile(attachment.filePath as string);
                  return fileBuffer.toString('base64');
                } catch (error) {
                  this.logger.warn(
                    {
                      conversationId: accepted.conversation.id,
                      requestId: accepted.requestId,
                      filePath: attachment.filePath,
                      error: error instanceof Error ? error.message : String(error)
                    },
                    'Unable to load image attachment for multimodal input'
                  );

                  return null;
                }
              })
          );

          return {
            role: message.role,
            content: message.content,
            ...(images.filter((image): image is string => Boolean(image)).length > 0
              ? {
                  images: images.filter((image): image is string => Boolean(image))
                }
              : {})
          };
        })
      );
      const initialPromptTokens = estimateOllamaMessageTokens(ollamaMessages);
      const priorConversationTokenTotal = this.turnMetadataService.getConversationUsageTotals(
        accepted.conversation.id
      ).totalTokens;
      const initialNumCtxBudget = this.resolveNumCtxBudget({
        model: accepted.model,
        promptTokens: initialPromptTokens,
        conversationId: accepted.conversation.id,
        modelSizeBytes: input.routePlan.selectedModelSizeBytes,
        priorConversationTokenTotal
      });
      const nativeToolDefinitions = this.toolDispatcher.listOllamaToolDefinitions();
      const shouldUseNativeToolLoop =
        input.routePlan.supportsNativeToolLoop &&
        this.shouldOfferNativeToolCalling({
          prompt: input.routePlan.cleanedPrompt,
          routeDecision: input.routePlan.routeDecision,
          toolDefinitions: nativeToolDefinitions,
          workspaceRootPath: workspace?.rootPath ?? null
        });
      const nativeToolWorkflowMode = this.resolveNativeToolWorkflowMode({
        prompt: input.routePlan.cleanedPrompt,
        routeDecision: input.routePlan.routeDecision,
        workspaceRootPath: workspace?.rootPath ?? null
      });
      const includeRepositoryAnalysisGuidance =
        this.shouldUseRepositoryAnalysisNativeToolGuidance({
          prompt: input.routePlan.cleanedPrompt,
          workspaceRootPath: workspace?.rootPath ?? null
        });
      const nativeToolCallRoundLimit = this.resolveNativeToolCallRoundLimit({
        model: accepted.model,
        prompt: input.routePlan.cleanedPrompt,
        routeDecision: input.routePlan.routeDecision,
        workspaceRootPath: workspace?.rootPath ?? null
      });
      const nativeToolCallHardLimit = this.resolveNativeToolCallHardLimit({
        model: accepted.model,
        prompt: input.routePlan.cleanedPrompt,
        routeDecision: input.routePlan.routeDecision,
        workspaceRootPath: workspace?.rootPath ?? null
      });
      const nativeToolCallRoundExtension = this.resolveNativeToolCallRoundExtension({
        model: accepted.model,
        prompt: input.routePlan.cleanedPrompt,
        routeDecision: input.routePlan.routeDecision,
        workspaceRootPath: workspace?.rootPath ?? null
      });

      if (shouldUseNativeToolLoop) {
        this.logger.info(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: accepted.assistantMessage.id,
            activeSkillId: input.routePlan.routeDecision.activeSkillId,
            workspaceRootPath: workspace?.rootPath ?? null,
            prompt: clipLoggedText(input.routePlan.cleanedPrompt),
            nativeToolWorkflowMode,
            includeRepositoryAnalysisGuidance,
            nativeToolStreaming: !isCloudHostedModel(accepted.model),
            maxNativeToolCallRounds: nativeToolCallRoundLimit,
            hardMaxNativeToolCallRounds: nativeToolCallHardLimit,
            nativeToolCallRoundExtension,
            numCtx: initialNumCtxBudget.numCtx,
            numCtxBudgetMode: initialNumCtxBudget.mode,
            priorConversationTokens: initialNumCtxBudget.priorConversationTokens,
            sessionRemainingTokens: initialNumCtxBudget.sessionRemainingTokens,
            resourceCap: initialNumCtxBudget.resourceCap
          },
          'Enabled native tool-calling loop for assistant turn'
        );

        const initialToolInvocations = [...toolInvocations];
        const initialToolContextSources = [...toolContextSources];
        const nativeToolResult = await this.runNativeToolCallingTurn({
          baseUrl: input.routePlan.baseUrl,
          apiKey: input.routePlan.apiKey,
          backend: input.routePlan.backend,
          model: accepted.model,
          messages: ollamaMessages,
          think: input.routePlan.thinkMode,
          toolDefinitions: nativeToolDefinitions,
          workspaceRootPath: workspace?.rootPath ?? null,
          workspaceId: workspace?.id ?? null,
          conversationId: accepted.conversation.id,
          modelSizeBytes: input.routePlan.selectedModelSizeBytes,
          priorConversationTokenTotal,
          workflowMode: nativeToolWorkflowMode,
          includeRepositoryAnalysisGuidance,
          maxRounds: nativeToolCallRoundLimit,
          hardMaxRounds: nativeToolCallHardLimit,
          roundExtension: nativeToolCallRoundExtension,
          onProgress: ({
            content: nativeToolContent,
            toolInvocations: nativeToolInvocations,
            contextSources: nativeToolContextSources
          }) => {
            content = nativeToolContent;
            toolInvocations = [...initialToolInvocations, ...nativeToolInvocations];
            toolContextSources = [...initialToolContextSources, ...nativeToolContextSources];
            this.reportAssistantProgressSafely({
              emitEvent: input.emitEvent,
              requestId: accepted.requestId,
              conversationId: accepted.conversation.id,
              assistantMessageId: accepted.assistantMessage.id,
              content,
              status: 'streaming',
              model: accepted.model,
              routeTrace,
              toolInvocations,
              contextSources: mergeContextSources(context.sources, toolContextSources)
            });
          },
          signal: activeTurn.abortController.signal
        });

        content = nativeToolResult.content;
        toolInvocations = [...initialToolInvocations, ...nativeToolResult.toolInvocations];
        toolContextSources = [...initialToolContextSources, ...nativeToolResult.contextSources];
        routeTrace = this.createRouteTrace(input.routePlan.routeDecision, {
          usedWorkspacePrompt: context.observability.usedWorkspacePrompt,
          usedPinnedMessages: context.observability.usedPinnedMessages,
          usedRag: context.observability.usedRag,
          usedTools: toolInvocations.length > 0
        });

        const finalUsage = this.createUsageEstimateFromContext(
          context.usageEstimate.promptTokens,
          content
        );
        const finalContextSources = mergeContextSources(context.sources, toolContextSources);

        this.finalizeAssistantCompletionSafely({
          conversationId: accepted.conversation.id,
          assistantMessageId: accepted.assistantMessage.id,
          requestId: accepted.requestId,
          emitEvent: input.emitEvent,
          content,
          doneReason: nativeToolResult.doneReason,
          model: accepted.model,
          routeTrace,
          usage: finalUsage,
          toolInvocations,
          contextSources: finalContextSources
        });

        this.logger.info(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: accepted.assistantMessage.id,
            model: accepted.model,
            strategy: routeTrace.strategy,
            doneReason: nativeToolResult.doneReason,
            usage: finalUsage,
            toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
            contextSourceCount: finalContextSources.length,
            assistantContent: clipLoggedText(content)
          },
          'Completed assistant turn after native tool calling'
        );

        return;
      }

      const result = await this.streamTextChat({
        backend: input.routePlan.backend,
        baseUrl: input.routePlan.baseUrl,
        apiKey: input.routePlan.apiKey,
        model: accepted.model,
        messages: ollamaMessages,
        numCtx: initialNumCtxBudget.numCtx,
        ...(input.routePlan.thinkMode === undefined ? {} : { think: input.routePlan.thinkMode }),
        signal: activeTurn.abortController.signal,
        onDelta: (delta) => {
          content += delta;
          this.repository.updateMessage(accepted.assistantMessage.id, {
            content,
            status: 'streaming',
            model: accepted.model
          });
          input.emitEvent({
            type: 'delta',
            requestId: accepted.requestId,
            assistantMessageId: accepted.assistantMessage.id,
            delta,
            content
          });
        }
      });
      const inlineToolRecovery = await this.recoverInlineToolCalls({
        backend: input.routePlan.backend,
        baseUrl: input.routePlan.baseUrl,
        apiKey: input.routePlan.apiKey,
        model: accepted.model,
        messages: ollamaMessages,
        content,
        doneReason: result.doneReason,
        workspaceRootPath: workspace?.rootPath ?? null,
        workspaceId: workspace?.id ?? null,
        conversationId: accepted.conversation.id
      });

      content = inlineToolRecovery.content;
      toolInvocations = [...toolInvocations, ...inlineToolRecovery.toolInvocations];
      toolContextSources = [...toolContextSources, ...inlineToolRecovery.contextSources];
      routeTrace = this.createRouteTrace(input.routePlan.routeDecision, {
        usedWorkspacePrompt: context.observability.usedWorkspacePrompt,
        usedPinnedMessages: context.observability.usedPinnedMessages,
        usedRag: context.observability.usedRag,
        usedTools: toolInvocations.length > 0
      });
      const finalUsage = this.createUsageEstimateFromContext(
        context.usageEstimate.promptTokens,
        content
      );
      const finalContextSources = mergeContextSources(context.sources, toolContextSources);

      this.finalizeAssistantCompletionSafely({
        conversationId: accepted.conversation.id,
        assistantMessageId: accepted.assistantMessage.id,
        requestId: accepted.requestId,
          emitEvent: input.emitEvent,
          content,
          doneReason: inlineToolRecovery.doneReason,
          model: accepted.model,
          routeTrace,
          toolInvocations,
          contextSources: finalContextSources,
          usage: finalUsage
        });

      this.logger.info(
        {
          requestId: accepted.requestId,
          conversationId: accepted.conversation.id,
          assistantMessageId: accepted.assistantMessage.id,
          model: accepted.model,
          strategy: routeTrace.strategy,
          doneReason: inlineToolRecovery.doneReason,
          usage: finalUsage,
          toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
          contextSourceCount: finalContextSources.length,
          assistantContent: clipLoggedText(content)
        },
        'Completed assistant turn'
      );
    } catch (error) {
      if (this.isAbortError(error) && activeTurn.cancelled) {
        const cancelledUsage = this.createUsageEstimateFromContext(
          context.usageEstimate.promptTokens,
          content
        );

        this.logger.info(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: accepted.assistantMessage.id,
            assistantContent: clipLoggedText(content),
            usage: cancelledUsage
          },
          'Assistant turn cancelled by user'
        );

        const cancelledContextSources = mergeContextSources(context.sources, toolContextSources);
        this.finalizeAssistantCompletionSafely({
          conversationId: accepted.conversation.id,
          assistantMessageId: accepted.assistantMessage.id,
          requestId: accepted.requestId,
          emitEvent: input.emitEvent,
          content,
          doneReason: 'cancelled',
          model: accepted.model,
          routeTrace,
          toolInvocations,
          contextSources: cancelledContextSources,
          usage: cancelledUsage
        });

        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown chat streaming error';

      const failedContextSources = mergeContextSources(context.sources, toolContextSources);
      this.logger.error(
        {
          requestId: accepted.requestId,
          conversationId: accepted.conversation.id,
          error: message,
          strategy: routeTrace.strategy,
          toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
          contextSourceCount: failedContextSources.length,
          assistantContent: clipLoggedText(content)
        },
        'Assistant turn failed'
      );

      this.repository.updateMessage(accepted.assistantMessage.id, {
        content,
        status: 'failed',
        model: accepted.model
      });
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: accepted.assistantMessage.id,
        routeTrace,
        usage: this.createUsageEstimateFromContext(context.usageEstimate.promptTokens, content),
        toolInvocations,
        contextSources: failedContextSources
      });
      input.emitEvent({
        type: 'error',
        requestId: accepted.requestId,
        assistantMessageId: accepted.assistantMessage.id,
        message,
        recoverable: true
      });
    } finally {
      this.activeAssistantTurns.delete(accepted.assistantMessage.id);
      this.queue.decrement();
    }
  }

  private async recoverInlineToolCalls(input: {
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: OllamaChatMessage[];
    content: string;
    doneReason: string | null;
    workspaceRootPath: string | null;
    workspaceId: string | null;
    conversationId: string;
  }): Promise<{
    content: string;
    doneReason: string | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }> {
    let messages = [...input.messages];
    let content = input.content;
    let doneReason = input.doneReason;
    const toolInvocations: ToolInvocation[] = [];
    const contextSources: ContextSource[] = [];

    for (let round = 0; round < INLINE_TOOL_CALL_ROUND_LIMIT; round += 1) {
      const { cleanedContent, toolCalls } = extractInlineMarkupToolCalls(content);

      if (toolCalls.length === 0) {
        return {
          content: cleanedContent || content,
          doneReason,
          toolInvocations,
          contextSources
        };
      }

      this.logger.info(
        {
          conversationId: input.conversationId,
          model: input.model,
          round: round + 1,
          toolNames: toolCalls.map((toolCall) => toolCall.toolName)
        },
        'Recovered inline tool-call markup from provider response'
      );

      const toolOutputs: string[] = [];

      for (const toolCall of toolCalls) {
        try {
          const result = await this.toolDispatcher.executeOllamaToolCall({
            toolName: toolCall.toolName,
            arguments: toolCall.arguments,
            workspaceRootPath: input.workspaceRootPath,
            workspaceId: input.workspaceId,
            conversationId: input.conversationId
          });

          toolInvocations.push(...result.toolInvocations);
          contextSources.push(...result.contextSources);
          toolOutputs.push(`### ${toolCall.toolName}\n${result.assistantContent}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Tool execution failed.';

          toolInvocations.push(
            this.turnMetadataService.createToolInvocation({
              toolId: toolCall.toolName,
              displayName:
                this.toolDispatcher.getById(toolCall.toolName)?.title ?? toolCall.toolName,
              status: 'failed',
              inputSummary:
                JSON.stringify(toolCall.arguments).slice(0, 800) || toolCall.toolName,
              outputSummary: null,
              outputText: `Tool execution failed.\nError: ${errorMessage}`,
              errorMessage
            })
          );
          toolOutputs.push(`### ${toolCall.toolName}\nTool execution failed.\nError: ${errorMessage}`);
        }
      }

      messages = [
        ...messages,
        ...(cleanedContent
          ? [{
              role: 'assistant' as const,
              content: cleanedContent
            }]
          : []),
        {
          role: 'system' as const,
          content: buildInlineToolExecutionResultPrompt(toolOutputs)
        }
      ];

      const followUp = await this.completeTextChat({
        backend: input.backend,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        messages
      });

      content = followUp.content;
      doneReason = followUp.doneReason;
    }

    const fallback = extractInlineMarkupToolCalls(content);

    return {
      content: fallback.cleanedContent || content,
      doneReason,
      toolInvocations,
      contextSources
    };
  }

  private shouldOfferNativeToolCalling(input: {
    prompt: string;
    routeDecision: RouteDecision;
    toolDefinitions: OllamaToolDefinition[];
    workspaceRootPath: string | null;
  }): boolean {
    if (input.toolDefinitions.length === 0) {
      return false;
    }

    const shouldEscalateInspectionTool =
      input.workspaceRootPath !== null &&
      looksLikeNativeFileMutationPrompt(input.prompt) &&
      input.routeDecision.activeToolId !== null &&
      NATIVE_TOOL_LOOP_ESCALATION_TOOL_IDS.has(input.routeDecision.activeToolId) &&
      (input.routeDecision.strategy === 'tool-chat' ||
        input.routeDecision.strategy === 'rag-tool');

    if (shouldEscalateInspectionTool) {
      return true;
    }

    if (input.routeDecision.activeToolId) {
      return false;
    }

    if (
      input.routeDecision.strategy !== 'chat' &&
      input.routeDecision.strategy !== 'skill-chat' &&
      input.routeDecision.strategy !== 'rag-chat'
    ) {
      return false;
    }

    return (
      NATIVE_TOOL_CALLING_PATTERN.test(input.prompt) ||
      looksLikeNativeFileMutationPrompt(input.prompt) ||
      (input.workspaceRootPath !== null && looksLikeRepositoryAnalysisPrompt(input.prompt)) ||
      (input.workspaceRootPath !== null &&
        ['builder', 'debugger'].includes(input.routeDecision.activeSkillId ?? ''))
    );
  }

  private emitAssistantUpdateEvent(input: {
    emitEvent: (event: ChatStreamEvent) => void;
    requestId: string;
    assistantMessageId: string;
    content: string;
    status: StoredMessage['status'];
    model?: string | null;
    routeTrace?: RouteTrace | null;
    toolInvocations?: ToolInvocation[];
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
  }): void {
    input.emitEvent({
      type: 'update',
      requestId: input.requestId,
      assistantMessageId: input.assistantMessageId,
      content: input.content,
      status: input.status,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.routeTrace === undefined ? {} : { routeTrace: input.routeTrace }),
      ...(input.toolInvocations === undefined ? {} : { toolInvocations: input.toolInvocations }),
      ...(input.contextSources === undefined ? {} : { contextSources: input.contextSources }),
      ...(input.usage === undefined ? {} : { usage: input.usage })
    });
  }

  private emitAssistantCompleteEvent(input: {
    emitEvent: (event: ChatStreamEvent) => void;
    requestId: string;
    assistantMessageId: string;
    content: string;
    doneReason: string | null;
    model?: string | null;
    routeTrace?: RouteTrace | null;
    toolInvocations?: ToolInvocation[];
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
  }): void {
    input.emitEvent({
      type: 'complete',
      requestId: input.requestId,
      assistantMessageId: input.assistantMessageId,
      content: input.content,
      doneReason: input.doneReason,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.routeTrace === undefined ? {} : { routeTrace: input.routeTrace }),
      ...(input.toolInvocations === undefined ? {} : { toolInvocations: input.toolInvocations }),
      ...(input.contextSources === undefined ? {} : { contextSources: input.contextSources }),
      ...(input.usage === undefined ? {} : { usage: input.usage })
    });
  }

  private reportAssistantProgressSafely(input: {
    emitEvent: (event: ChatStreamEvent) => void;
    requestId: string;
    conversationId: string;
    assistantMessageId: string;
    content: string;
    status: StoredMessage['status'];
    model?: string | null;
    routeTrace?: RouteTrace | null;
    toolInvocations?: ToolInvocation[];
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
  }): void {
    try {
      this.repository.updateMessage(input.assistantMessageId, {
        content: input.content,
        status: input.status,
        model: input.model ?? null
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          status: input.status
        },
        'Unable to persist assistant progress snapshot'
      );
    }

    try {
      this.emitAssistantUpdateEvent(input);
      return;
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          toolInvocationCount: input.toolInvocations?.length ?? 0,
          contextSourceCount: input.contextSources?.length ?? 0
        },
        'Unable to emit full assistant progress payload; retrying with minimal payload'
      );
    }

    try {
      this.emitAssistantUpdateEvent({
        emitEvent: input.emitEvent,
        requestId: input.requestId,
        assistantMessageId: input.assistantMessageId,
        content: input.content,
        status: input.status,
        ...(input.model === undefined ? {} : { model: input.model })
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error)
        },
        'Unable to emit minimal assistant progress payload'
      );
    }
  }

  private saveAssistantTurnArtifactsSafely(input: {
    conversationId: string;
    assistantMessageId: string;
    routeTrace: RouteTrace;
    usage: MessageUsage | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }): void {
    try {
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: input.assistantMessageId,
        routeTrace: input.routeTrace,
        usage: input.usage,
        toolInvocations: input.toolInvocations,
        contextSources: input.contextSources
      });
      return;
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          toolInvocationCount: input.toolInvocations.length,
          contextSourceCount: input.contextSources.length
        },
        'Unable to persist full assistant turn artifacts; retrying without context sources'
      );
    }

    try {
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: input.assistantMessageId,
        routeTrace: input.routeTrace,
        usage: input.usage,
        toolInvocations: input.toolInvocations,
        contextSources: []
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          toolInvocationCount: input.toolInvocations.length
        },
        'Unable to persist assistant turn artifacts even after dropping context sources'
      );
    }
  }

  private finalizeAssistantCompletionSafely(input: {
    conversationId: string;
    assistantMessageId: string;
    requestId: string;
    emitEvent: (event: ChatStreamEvent) => void;
    content: string;
    doneReason: string | null;
    model?: string | null;
    routeTrace: RouteTrace;
    usage: MessageUsage | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }): void {
    try {
      this.repository.updateMessage(input.assistantMessageId, {
        content: input.content,
        status: 'completed',
        model: input.model ?? null
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error)
        },
        'Unable to persist completed assistant message before final emission'
      );
    }

    this.saveAssistantTurnArtifactsSafely({
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      routeTrace: input.routeTrace,
      usage: input.usage,
      toolInvocations: input.toolInvocations,
      contextSources: input.contextSources
    });

    try {
      this.emitAssistantCompleteEvent({
        emitEvent: input.emitEvent,
        requestId: input.requestId,
        assistantMessageId: input.assistantMessageId,
        content: input.content,
        doneReason: input.doneReason,
        ...(input.model === undefined ? {} : { model: input.model }),
        routeTrace: input.routeTrace,
        toolInvocations: input.toolInvocations,
        contextSources: input.contextSources,
        usage: input.usage
      });
      return;
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          toolInvocationCount: input.toolInvocations.length,
          contextSourceCount: input.contextSources.length
        },
        'Unable to emit full assistant completion payload; retrying with minimal payload'
      );
    }

    try {
      this.emitAssistantCompleteEvent({
        emitEvent: input.emitEvent,
        requestId: input.requestId,
        assistantMessageId: input.assistantMessageId,
        content: input.content,
        doneReason: input.doneReason,
        ...(input.model === undefined ? {} : { model: input.model })
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error)
        },
        'Unable to emit minimal assistant completion payload'
      );
    }
  }

  private resolveNativeToolWorkflowMode(input: {
    prompt: string;
    routeDecision: RouteDecision;
    workspaceRootPath: string | null;
  }): NativeToolWorkflowMode {
    return input.workspaceRootPath !== null &&
      (['builder', 'debugger'].includes(input.routeDecision.activeSkillId ?? '') ||
        looksLikeNativeFileMutationPrompt(input.prompt))
      ? 'coding'
      : 'default';
  }

  private shouldUseRepositoryAnalysisNativeToolGuidance(input: {
    prompt: string;
    workspaceRootPath: string | null;
  }): boolean {
    return (
      input.workspaceRootPath !== null && looksLikeRepositoryAnalysisPrompt(input.prompt)
    );
  }

  private resolveNativeToolCallRoundLimit(input: {
    model: string;
    prompt: string;
    routeDecision: RouteDecision;
    workspaceRootPath: string | null;
  }): number {
    if (this.resolveNativeToolWorkflowMode(input) === 'coding') {
      return isCloudHostedModel(input.model)
        ? CODING_NATIVE_TOOL_CALL_ROUNDS
        : LOCAL_CODING_NATIVE_TOOL_CALL_ROUNDS;
    }

    if (this.shouldUseRepositoryAnalysisNativeToolGuidance(input)) {
      return isCloudHostedModel(input.model)
        ? REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS
        : LOCAL_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS;
    }

    return isCloudHostedModel(input.model)
      ? DEFAULT_MAX_NATIVE_TOOL_CALL_ROUNDS
      : MAX_LOCAL_NATIVE_TOOL_CALL_ROUNDS;
  }

  private resolveNativeToolCallHardLimit(input: {
    model: string;
    prompt: string;
    routeDecision: RouteDecision;
    workspaceRootPath: string | null;
  }): number {
    if (this.resolveNativeToolWorkflowMode(input) === 'coding') {
      return isCloudHostedModel(input.model)
        ? MAX_CODING_NATIVE_TOOL_CALL_ROUNDS
        : MAX_LOCAL_CODING_NATIVE_TOOL_CALL_ROUNDS;
    }

    if (this.shouldUseRepositoryAnalysisNativeToolGuidance(input)) {
      return isCloudHostedModel(input.model)
        ? MAX_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS
        : MAX_LOCAL_REPOSITORY_ANALYSIS_NATIVE_TOOL_CALL_ROUNDS;
    }

    return isCloudHostedModel(input.model)
      ? DEFAULT_MAX_NATIVE_TOOL_CALL_ROUNDS
      : MAX_LOCAL_NATIVE_TOOL_CALL_ROUNDS;
  }

  private resolveNativeToolCallRoundExtension(input: {
    model: string;
    prompt: string;
    routeDecision: RouteDecision;
    workspaceRootPath: string | null;
  }): number {
    if (this.resolveNativeToolWorkflowMode(input) !== 'coding') {
      return 0;
    }

    return isCloudHostedModel(input.model)
      ? CODING_NATIVE_TOOL_ROUND_EXTENSION
      : LOCAL_CODING_NATIVE_TOOL_ROUND_EXTENSION;
  }

  private injectNativeToolLoopGuidance(
    messages: OllamaChatMessage[],
    workflowMode: NativeToolWorkflowMode,
    includeRepositoryAnalysisGuidance: boolean,
    toolDefinitions: OllamaToolDefinition[],
    planContext?: { planState: import('@bridge/ipc/contracts').PlanState | null; tasks: import('@bridge/ipc/contracts').CapabilityTask[] }
  ): OllamaChatMessage[] {
    const firstNonSystemIndex = messages.findIndex((message) => message.role !== 'system');
    const guidanceParts = [
      NATIVE_TOOL_LOOP_SYSTEM_PROMPT,
      PLAN_MODE_NATIVE_TOOL_LOOP_SYSTEM_PROMPT,
      buildNativeToolReferencePrompt(toolDefinitions)
    ];

    if (planContext) {
      const { planState, tasks } = planContext;
      const planStatusLine = planState?.status === 'active'
        ? `Plan mode: ACTIVE (conversation ${planState.conversationId ?? 'unknown'})`
        : 'Plan mode: INACTIVE';
      const taskLines = tasks.length > 0
        ? tasks.map((t) => `${t.sequence}. [${t.status}] \`${t.id}\` | ${t.title}`)
        : ['(no tasks yet)'];
      guidanceParts.push(
        `Current plan state:\n${planStatusLine}\n\nTracked tasks:\n${taskLines.join('\n')}\n\nIf plan mode is already active and tasks exist, continue from where the plan left off — update in-progress tasks, complete pending ones, do not recreate already-tracked work.`
      );
    }

    if (includeRepositoryAnalysisGuidance) {
      guidanceParts.push(REPOSITORY_ANALYSIS_NATIVE_TOOL_LOOP_SYSTEM_PROMPT);
    }

    if (workflowMode === 'coding') {
      guidanceParts.push(CODING_NATIVE_TOOL_LOOP_SYSTEM_PROMPT);
    }

    const guidanceMessage: OllamaChatMessage = {
      role: 'system',
      content: guidanceParts.join('\n\n')
    };

    if (firstNonSystemIndex === -1) {
      return [...messages, guidanceMessage];
    }

    return [
      ...messages.slice(0, firstNonSystemIndex),
      guidanceMessage,
      ...messages.slice(firstNonSystemIndex)
    ];
  }

  private async runNativeToolCallingTurn(input: {
    backend: TextInferenceBackend;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: OllamaChatMessage[];
    think?: OllamaThinkValue | undefined;
    toolDefinitions: OllamaToolDefinition[];
    workspaceRootPath: string | null;
    workspaceId: string | null;
    conversationId: string;
    modelSizeBytes: number | null;
    priorConversationTokenTotal: number;
    workflowMode: NativeToolWorkflowMode;
    includeRepositoryAnalysisGuidance: boolean;
    maxRounds: number;
    hardMaxRounds: number;
    roundExtension: number;
    onProgress?: ((input: {
      content: string;
      toolInvocations: ToolInvocation[];
      contextSources: ContextSource[];
    }) => void) | undefined;
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    doneReason: string | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }> {
    let messages = this.injectNativeToolLoopGuidance(
      input.messages,
      input.workflowMode,
      input.includeRepositoryAnalysisGuidance,
      input.toolDefinitions,
      this.toolDispatcher.getPlanContext(input.workspaceId)
    );
    const toolInvocations: ToolInvocation[] = [];
    const contextSources: ContextSource[] = [];
    const hardMaxRounds = Math.max(input.maxRounds, input.hardMaxRounds);
    let currentMaxRounds = input.maxRounds;
    let lastRoundExtensionProgressIndex = 0;
    let visibleContent = '';
    let missingToolCallReminderCount = 0;
    let failedToolRecoveryReminderCount = 0;

    for (let round = 0; round < hardMaxRounds; round += 1) {
      if (round >= currentMaxRounds) {
        const canExtendRoundBudget =
          input.workflowMode === 'coding' &&
          currentMaxRounds < hardMaxRounds &&
          hasCompletedToolProgressSince(toolInvocations, lastRoundExtensionProgressIndex);

        if (!canExtendRoundBudget) {
          throw new Error(
            input.workflowMode === 'coding'
              ? `The model exceeded the coding implement-check round limit of ${currentMaxRounds}${currentMaxRounds >= hardMaxRounds ? ' (hard cap).' : '.'}`
              : `The model exceeded the local tool-call round limit of ${input.maxRounds}.`
          );
        }

        const previousMaxRounds = currentMaxRounds;
        currentMaxRounds = Math.min(
          currentMaxRounds + Math.max(1, input.roundExtension),
          hardMaxRounds
        );
        lastRoundExtensionProgressIndex = toolInvocations.length;

        this.logger.info(
          {
            conversationId: input.conversationId,
            model: input.model,
            previousMaxRounds,
            maxRounds: currentMaxRounds,
            hardMaxRounds,
            completedToolCount: toolInvocations.length
          },
          'Extended coding implement-check round budget after continued tool progress'
        );
      }

      let roundContent = '';
      const roundNumCtx = this.resolveNumCtxBudget({
        model: input.model,
        promptTokens: estimateOllamaMessageTokens(messages),
        conversationId: input.conversationId,
        modelSizeBytes: input.modelSizeBytes,
        priorConversationTokenTotal: input.priorConversationTokenTotal
      }).numCtx;
      const completion = isCloudHostedModel(input.model)
        ? await this.ollamaClient.completeChat({
            baseUrl: input.baseUrl,
            model: input.model,
            messages,
            tools: input.toolDefinitions,
            numCtx: roundNumCtx,
            ...(input.think === undefined ? {} : { think: input.think }),
            ...(input.signal ? { signal: input.signal } : {})
          })
        : await this.ollamaClient.streamChat({
            baseUrl: input.baseUrl,
            model: input.model,
            messages,
            tools: input.toolDefinitions,
            numCtx: roundNumCtx,
            ...(input.think === undefined ? {} : { think: input.think }),
            ...(input.signal ? { signal: input.signal } : {}),
            onDelta: (delta) => {
              roundContent += delta;
              visibleContent = roundContent;
              input.onProgress?.({
                content: visibleContent,
                toolInvocations: [...toolInvocations],
                contextSources: [...contextSources]
              });
            }
          });

      if (completion.content && roundContent !== completion.content) {
        visibleContent = completion.content;
        input.onProgress?.({
          content: visibleContent,
          toolInvocations: [...toolInvocations],
          contextSources: [...contextSources]
        });
      }

      if (completion.toolCalls.length === 0) {
        const unrecoveredFailure = findLatestUnrecoveredToolFailure(toolInvocations);

        if (
          unrecoveredFailure &&
          !isEnvironmentBlockedToolFailure(unrecoveredFailure) &&
          failedToolRecoveryReminderCount < MAX_FAILED_TOOL_RECOVERY_REMINDERS
        ) {
          failedToolRecoveryReminderCount += 1;

          this.logger.info(
            {
              conversationId: input.conversationId,
              model: input.model,
              failedToolId: unrecoveredFailure.toolId,
              failedToolError: unrecoveredFailure.errorMessage,
              failedToolRecoveryReminderCount
            },
            'Continuing native tool turn after a recoverable tool failure'
          );

          messages = [
            ...messages,
            {
              role: 'assistant',
              content: completion.content,
              ...(completion.thinking ? { thinking: completion.thinking } : {})
            },
            {
              role: 'system',
              content: buildToolFailureRecoveryReminder({
                failure: unrecoveredFailure,
                toolDefinitions: input.toolDefinitions
              })
            }
          ];
          continue;
        }

        if (
          toolInvocations.length === 0 &&
          missingToolCallReminderCount < MAX_MISSING_TOOL_CALL_REMINDERS
        ) {
          missingToolCallReminderCount += 1;

          this.logger.info(
            {
              conversationId: input.conversationId,
              model: input.model,
              missingToolCallReminderCount,
              workflowMode: input.workflowMode,
              includeRepositoryAnalysisGuidance: input.includeRepositoryAnalysisGuidance
            },
            'Continuing native tool turn because no tool call has been made yet'
          );

          messages = [
            ...messages,
            {
              role: 'assistant',
              content: completion.content,
              ...(completion.thinking ? { thinking: completion.thinking } : {})
            },
            {
              role: 'system',
              content: buildMissingToolUseReminder({
                workflowMode: input.workflowMode,
                includeRepositoryAnalysisGuidance: input.includeRepositoryAnalysisGuidance,
                toolDefinitions: input.toolDefinitions
              })
            }
          ];
          continue;
        }

        if (
          input.workflowMode === 'coding' &&
          !hasCodingVerificationAfterLatestMutation(toolInvocations)
        ) {
          this.logger.info(
            {
              conversationId: input.conversationId,
              model: input.model,
              completedToolCount: toolInvocations.length,
              pendingMutationTargets: listRecentCodingMutationTargets(toolInvocations)
            },
            'Continuing coding turn because the latest file changes have not been verified yet'
          );

          messages = [
            ...messages,
            {
              role: 'assistant',
              content: completion.content,
              ...(completion.thinking ? { thinking: completion.thinking } : {})
            },
            {
              role: 'system',
              content: buildCodingVerificationReminder(toolInvocations)
            }
          ];
          continue;
        }

        return {
          content: completion.content,
          doneReason: completion.doneReason,
          toolInvocations,
          contextSources
        };
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: completion.content,
          ...(completion.thinking ? { thinking: completion.thinking } : {}),
          tool_calls: completion.toolCalls
        }
      ];

      for (const toolCall of completion.toolCalls) {
        const toolResponse = await this.executeNativeToolCall({
          toolCall,
          workspaceRootPath: input.workspaceRootPath,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId
        });

        toolInvocations.push(...toolResponse.toolInvocations);
        contextSources.push(...toolResponse.contextSources);
        input.onProgress?.({
          content: visibleContent,
          toolInvocations: [...toolInvocations],
          contextSources: [...contextSources]
        });
        messages.push({
          role: 'tool',
          tool_name: toolCall.function.name,
          content: toolResponse.content
        });
      }
    }

    throw new Error(
      input.workflowMode === 'coding'
        ? `The model exceeded the coding implement-check round limit of ${hardMaxRounds} (hard cap).`
        : `The model exceeded the local tool-call round limit of ${input.maxRounds}.`
    );
  }

  private async executeNativeToolCall(input: {
    toolCall: OllamaToolCall;
    workspaceRootPath: string | null;
    workspaceId: string | null;
    conversationId: string;
  }): Promise<{
    content: string;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }> {
    const toolId = input.toolCall.function.name;

    try {
      const result = await this.toolDispatcher.executeOllamaToolCall({
        toolName: toolId,
        arguments: input.toolCall.function.arguments,
        workspaceRootPath: input.workspaceRootPath,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId
      });

      this.logger.info(
        {
          conversationId: input.conversationId,
          toolId,
          arguments: clipLoggedText(JSON.stringify(input.toolCall.function.arguments), 1_200),
          toolInvocations: summarizeLoggedToolInvocations(result.toolInvocations),
          contextSourceCount: result.contextSources.length,
          toolContent: clipLoggedText(result.assistantContent)
        },
        'Executed native Ollama tool call'
      );

      return {
        content: result.assistantContent,
        toolInvocations: result.toolInvocations,
        contextSources: result.contextSources
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      const failedInvocation = this.turnMetadataService.createToolInvocation({
        toolId,
        displayName: this.toolDispatcher.getById(toolId)?.title ?? toolId,
        status: 'failed',
        inputSummary: JSON.stringify(input.toolCall.function.arguments),
        outputSummary: null,
        outputText: `Tool execution failed.\nError: ${message}`,
        errorMessage: message
      });

      this.logger.warn(
        {
          conversationId: input.conversationId,
          toolId,
          arguments: clipLoggedText(JSON.stringify(input.toolCall.function.arguments), 1_200),
          error: message
        },
        'Native Ollama tool call failed'
      );

      return {
        content: [
          `Tool execution failed for ${toolId}: ${message}`,
          'Recovery hint:',
          ...buildToolFailureRecoveryHint(failedInvocation)
        ].join('\n'),
        toolInvocations: [failedInvocation],
        contextSources: []
      };
    }
  }

  private findLatestImageAttachments(recentMessages: StoredMessage[]): MessageAttachment[] {
    for (const message of [...recentMessages].reverse()) {
      if (message.role !== 'user') {
        continue;
      }

      const imageAttachments = message.attachments.filter(isImageAttachment);

      if (imageAttachments.length > 0) {
        return imageAttachments.slice(0, 3);
      }
    }

    return [];
  }

  private async buildLatestGenerationReferenceImages(
    recentGenerationJobs: GenerationJob[]
  ): Promise<MessageAttachment[]> {
    const latestJobWithArtifacts = recentGenerationJobs.find((job) =>
      job.artifacts.some((artifact) => artifact.mimeType.startsWith('image/'))
    );

    if (!latestJobWithArtifacts) {
      return [];
    }

    const latestArtifactPaths = latestJobWithArtifacts.artifacts
      .filter((artifact) => artifact.mimeType.startsWith('image/'))
      .map((artifact) => artifact.filePath)
      .slice(0, 3);

    if (latestArtifactPaths.length === 0) {
      return [];
    }

    try {
      return await this.prepareAttachments(latestArtifactPaths);
    } catch (error) {
      this.logger.warn(
        {
          jobId: latestJobWithArtifacts.id,
          error: error instanceof Error ? error.message : String(error)
        },
        'Unable to prepare latest generated images for follow-up image editing'
      );
      return [];
    }
  }

  private collectPriorImageContextAttachments(input: {
    recentMessages: StoredMessage[];
    recentGenerationJobs: GenerationJob[];
    excludeAttachments: MessageAttachment[];
    limit: number;
  }): MessageAttachment[] {
    const excludedKeys = new Set(input.excludeAttachments.map(getImageAttachmentKey));
    const candidateGroups: MessageAttachment[][] = [];

    for (const job of input.recentGenerationJobs) {
      const distinctJobReferenceImages = job.referenceImages.filter(
        (attachment) =>
          isImageAttachment(attachment) && !excludedKeys.has(getImageAttachmentKey(attachment))
      );

      if (distinctJobReferenceImages.length > 0) {
        candidateGroups.push(distinctJobReferenceImages);
      }
    }

    for (const message of [...input.recentMessages].reverse()) {
      if (message.role !== 'user') {
        continue;
      }

      const distinctMessageReferenceImages = message.attachments.filter(
        (attachment) =>
          isImageAttachment(attachment) && !excludedKeys.has(getImageAttachmentKey(attachment))
      );

      if (distinctMessageReferenceImages.length > 0) {
        candidateGroups.push(distinctMessageReferenceImages);
      }
    }

    return mergeDistinctImageAttachments(candidateGroups, input.limit);
  }

  private parsePromptDirectives(prompt: string): PromptDirectives {
    let remaining = prompt.trim();
    let explicitSkillId: string | null = null;
    let explicitToolId: string | null = null;

    while (remaining.startsWith('/') || remaining.startsWith('@')) {
      const tokenMatch = remaining.match(/^([/@][^\s]+)\s*(.*)$/s);

      if (!tokenMatch) {
        break;
      }

      const token = tokenMatch[1];
      const rest = tokenMatch[2] ?? '';

      if (token?.startsWith('/')) {
        const tool = this.toolDispatcher.findByCommand(token);

        if (!tool || explicitToolId) {
          break;
        }

        explicitToolId = tool.id;
        remaining = rest.trim();
        continue;
      }

      if (token?.startsWith('@')) {
        const skill = this.skillRegistry.getById(token.slice(1));

        if (!skill || explicitSkillId) {
          break;
        }

        explicitSkillId = skill.id;
        remaining = rest.trim();
        continue;
      }

      break;
    }

    return {
      cleanedPrompt: remaining || prompt.trim(),
      explicitSkillId,
      explicitToolId
    };
  }

  private resolveToolExecutionPrompt(input: {
    cleanedPrompt: string;
    routeDecision: RouteDecision;
    recentMessages: StoredMessage[];
  }): string {
    if (
      input.routeDecision.reason !== 'follow-up-tool-carry-forward' ||
      !input.routeDecision.activeToolId
    ) {
      return input.cleanedPrompt;
    }

    if (
      this.shouldPreferCurrentToolPrompt(
        input.routeDecision.activeToolId,
        input.cleanedPrompt
      )
    ) {
      return input.cleanedPrompt;
    }

    const previousToolPrompt = this.findPreviousToolExecutionPrompt(
      input.routeDecision.activeToolId,
      input.recentMessages
    );

    if (!previousToolPrompt) {
      return input.cleanedPrompt;
    }

    this.logger.info(
      {
        toolId: input.routeDecision.activeToolId,
        reusedPrompt: previousToolPrompt
      },
      'Reused prior tool input for follow-up tool retry'
    );

    return previousToolPrompt;
  }

  private findPreviousToolExecutionPrompt(
    toolId: string,
    recentMessages: StoredMessage[]
  ): string | null {
    for (const message of [...recentMessages].reverse()) {
      if (message.role !== 'assistant' || message.routeTrace?.activeToolId !== toolId) {
        continue;
      }

      const previousInvocation = [...(message.toolInvocations ?? [])]
        .reverse()
        .find(
          (invocation) =>
            invocation.toolId === toolId &&
            invocation.inputSummary.trim().length > 0 &&
            !this.isFollowUpToolRetryPrompt(invocation.inputSummary)
        );

      if (previousInvocation) {
        return previousInvocation.inputSummary.trim();
      }
    }

    return null;
  }

  private isFollowUpToolRetryPrompt(prompt: string): boolean {
    return FOLLOW_UP_TOOL_RETRY_PATTERN.test(prompt.trim());
  }

  private shouldPreferCurrentToolPrompt(toolId: string, prompt: string): boolean {
    if (!['workspace-lister', 'workspace-search', 'file-reader'].includes(toolId)) {
      return false;
    }

    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt || this.isFollowUpToolRetryPrompt(trimmedPrompt)) {
      return false;
    }

    return (
      FOLLOW_UP_TOOL_CORRECTION_PATTERN.test(trimmedPrompt) &&
      LIKELY_TOOL_PATH_PATTERN.test(trimmedPrompt)
    );
  }

  private createRouteTrace(
    decision: RouteDecision,
    usage: {
      usedWorkspacePrompt: boolean;
      usedPinnedMessages: boolean;
      usedRag: boolean;
      usedTools: boolean;
    }
  ): RouteTrace {
    return {
      strategy: decision.strategy,
      reason: decision.reason,
      confidence: decision.confidence,
      selectedModel: decision.selectedModel,
      fallbackModel: decision.fallbackModel,
      activeSkillId: decision.activeSkillId,
      activeToolId: decision.activeToolId,
      usedWorkspacePrompt: usage.usedWorkspacePrompt,
      usedPinnedMessages: usage.usedPinnedMessages,
      usedRag: usage.usedRag,
      usedTools: usage.usedTools
    };
  }

  private createUsageEstimate(prompt: string, content: string): MessageUsage {
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  private createUsageEstimateFromContext(promptTokens: number, content: string): MessageUsage {
    const completionTokens = content.trim() ? estimateTokens(content) : 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'AbortError')
    );
  }

  private async resolveWorkspaceRootPath(rootPath: string): Promise<string> {
    const resolvedRootPath = path.resolve(rootPath);
    const rootStat = await stat(resolvedRootPath);

    if (!rootStat.isDirectory()) {
      throw new Error('Workspace folder must point to a local directory.');
    }

    return resolvedRootPath;
  }

  private decorateMessages(messages: StoredMessage[]): StoredMessage[] {
    return this.turnMetadataService.decorateMessages(messages);
  }

  private decorateMessage(messageId: string): StoredMessage {
    const message = this.repository.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} was not found.`);
    }

    return this.decorateMessages([message])[0] ?? message;
  }

  private isKnownLocalFilePath(normalizedPath: string): boolean {
    return (
      this.previewAllowedPaths.has(normalizedPath) ||
      this.repository.hasAttachmentPath(normalizedPath) ||
      this.generationRepository?.hasKnownFilePath(normalizedPath) === true
    );
  }
}
