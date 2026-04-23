import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import {
  canInlineAttachmentText,
  inferMimeType,
  isImageFilePath,
  isVideoFilePath
} from '@bridge/chat/attachment-utils';
import type { TurnMetadataService } from '@bridge/chat/turn-metadata';
import { buildConversationContext } from '@bridge/context';
import type {
  CancelChatTurnInput,
  CapabilityTask,
  ChatStartAccepted,
  ContextSource,
  ConversationExportPayload,
  CreateSkillInput,
  CreateWorkspaceInput,
  DeleteSkillInput,
  EditMessageInput,
  ChatStreamEvent,
  ChatTurnAccepted,
  ChatTurnRequest,
  GenerationJob,
  ImageGenerationRequest,
  ImportWorkspaceKnowledgeResult,
  KnowledgeDocument,
  MessageAttachment,
  MessageUsage,
  OllamaThinkMode,
  PlanState,
  RegenerateResponseInput,
  RouteTrace,
  SkillDefinition,
  StoredMessage,
  TextInferenceBackend,
  ToolDefinition,
  ToolInvocation,
  UpdateSkillInput,
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
  type ChatRouter,
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
const MAX_VIDEO_PREVIEW_BYTES = 256 * 1024 * 1024;
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
const CODE_IMPLEMENTATION_STACK_PATTERN =
  /\b(?:html|css|javascript|typescript|react|vue|svelte|node(?:\.js)?|three(?:\.js)?|webgl|canvas)\b/i;
const CODE_IMPLEMENTATION_RUNTIME_PATTERN =
  /\b(?:single file|single script|one file|must run|run in chrome|run in (?:the )?browser|chrome browser|browser app|web app|webpage|website)\b/i;
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
const MIN_DYNAMIC_NUM_CTX = 32_768;
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
const TEXT_COMMAND_RECOVERY_MARKER = '[bridge-text-command-recovery]';
const NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `You MUST invoke tools using the native function-calling API (tool_calls). Never output slash commands like /plan-on or /task-create as plain text — always use proper tool_calls objects.

Work efficiently:
- Read a file before modifying it — never assume its current contents.
- For small, targeted changes use edit({filePath, startLine, endLine, newText}) — read the file first to get exact line numbers.
- For changes that touch most of a file, use write({filePath, content}) with the complete new file contents in the same call. Never call write with only a path.
- Batch independent tool calls in one response instead of one call per turn.
- When the task is done, stop calling tools and answer the user directly with a concise summary of what changed and why.`;
const CODING_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For coding tasks in the connected workspace, follow an implement-verify loop. Always use tool_calls objects — never plain-text commands:
- Before modifying, read the target file and any direct callers or imports that the change will affect.
- For small, targeted changes use edit({filePath, startLine, endLine, newText}) — read the file first to get exact line numbers.
- For changes that restructure or touch most of a file, use write({filePath, content}) with the complete new file contents in the same call. Never call write with only a path.
- For larger scaffolds, batch several related edits or writes in the same response instead of one file per round.
- After modifying, re-read every changed section to confirm correctness before proceeding.
- Run the most relevant bounded validation command (typecheck, lint, or targeted test) before stopping.
- If validation fails due to your changes, diagnose the error message, fix the root cause, and re-run — do not stop on a failing result.
- If automated validation is unavailable, re-read all changed files and explicitly confirm the stated requirement is met.`;
const REPOSITORY_ANALYSIS_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For repository or codebase analysis tasks, always use tool_calls — never plain-text commands:
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

  lines.push('', 'To continue: call task-update with the task ID and status. To add tasks: call task-create. To finish: call exit-plan-mode when all tasks are complete.');

  return lines.join('\n');
}

const PLAN_MODE_NATIVE_TOOL_LOOP_SYSTEM_PROMPT = `For any multi-step task, activate plan mode and track your work with tasks before starting. Always use tool_calls — never plain-text commands like /plan-on:
1. Call enter-plan-mode first to activate structured planning for this conversation.
2. Call task-create for each distinct unit of work — one task per major step or deliverable.
3. When you begin a step, call task-update with status "in_progress".
4. When a step is complete, call task-update with status "completed".
5. If a planned step becomes unnecessary, call task-stop to cancel it.
6. After all tasks are complete and the user's goal is fully met, call exit-plan-mode.
For trivial single-step requests that require only one tool call, you may skip plan mode.`;
const NATIVE_TOOL_USE_REQUIRED_SYSTEM_PROMPT = `This turn requires tool use. Do not answer from memory alone.
Respond with a tool_calls object for the appropriate tool — never output plain-text commands or slash commands.
If unsure where to start, use workspace-lister or glob to discover the workspace.`;
const INTERCEPTED_TOOL_CALL_CONTINUATION_SYSTEM_PROMPT = `A tool call in your previous response was intercepted and executed by the bridge.
- Do not repeat the same tool call.
- If you still need another tool, respond with a tool_calls object — not plain-text commands or slash commands.
- When the task is complete, answer in plain text with no further tool calls.`;
const TOOL_FAILURE_RECOVERY_SYSTEM_PROMPT = `The latest tool call failed and the task is not complete. Do not stop.
Retry with corrected arguments using a tool_calls object, or choose a better tool for the next step.`;
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
const NATIVE_TOOL_LOOP_SKILL_IDS = new Set(['builder', 'debugger', 'grounded']);
const NATIVE_TOOL_LOOP_ESCALATION_TOOL_IDS = new Set([
  'read',
  'file-reader',
  'workspace-lister',
  'workspace-search',
  'glob',
  'grep',
  'lsp',
  'enter-plan-mode',
  'exit-plan-mode',
  'task-create',
  'task-update',
  'task-stop',
  'todo-write'
]);
const CAPABILITY_SURFACE_TOOL_IDS = new Set([
  'enter-plan-mode',
  'exit-plan-mode',
  'task-create',
  'task-update',
  'task-stop',
  'todo-write'
]);
const NATIVE_TOOL_CALLING_PATTERN =
  /\b(read|open|list|show|search|find|grep|glob|fetch|download|task|tasks|schedule|cron|worktree|definition|references|diagnostics|calculate|compute|powershell|command|tool|tools|agent|subagent|team|todo|checklist|milestone|notebook|resource|mcp|clarify|skill)\b|plan mode|https?:\/\/|[A-Za-z]:\\|\.{1,2}[\\/]/i;
const NATIVE_FILE_MUTATION_PATTERN =
  /\b(write|save|create|update|modify|change|fix|rewrite|correct|repair)\b[\s\S]{0,64}(?:\b(file|folder|directory|document|notebook|markdown|json|yaml|yml|toml|txt|ts|tsx|js|jsx|py|sql|css|html|md|readme)\b|(?:[A-Za-z]:\\|\.{0,2}[\\/]|\/)?[A-Za-z0-9_.-]+\.(?:md|json|yaml|yml|toml|txt|ts|tsx|js|jsx|py|sql|css|html))\b/i;
type NativeToolWorkflowMode = 'default' | 'coding';
type CapabilitySurfaceSnapshot = {
  capabilityTasks: CapabilityTask[];
  capabilityPlanState: PlanState | null;
};
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

function looksLikeCodeImplementationPrompt(prompt: string): boolean {
  return (
    /(?:using|with)\s+(?:html|css|javascript|typescript|react|vue|svelte|node(?:\.js)?|three(?:\.js)?|webgl|canvas)\b/i.test(
      prompt
    ) ||
    /\bhtml\b[\s,/+&-]+\bcss\b|\bcss\b[\s,/+&-]+\bjavascript\b|\bhtml\b[\s,/+&-]+\bjavascript\b/i.test(
      prompt
    ) ||
    (CODE_IMPLEMENTATION_STACK_PATTERN.test(prompt) &&
      CODE_IMPLEMENTATION_RUNTIME_PATTERN.test(prompt))
  );
}

function looksLikeTextToImagePrompt(prompt: string): boolean {
  return (
    IMAGE_GENERATION_PATTERN.test(prompt) &&
    IMAGE_OBJECT_PATTERN.test(prompt) &&
    !looksLikeCodeImplementationPrompt(prompt)
  );
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

function looksLikeCodingTaskPrompt(prompt: string): boolean {
  return /\b(implement|build|create|add|update|fix|debug|refactor|rewrite|repair|support|extend|scaffold|wire(?:\s+up)?|modify|change)\b/i.test(
    prompt
  );
}

function looksLikeWorkspaceInspectionPrompt(prompt: string): boolean {
  return (
    /\b(list|show|open|read|inspect|browse|search|find|grep|glob|tree)\b/i.test(prompt) &&
    /\b(file|files|folder|folders|directory|directories|workspace)\b/i.test(prompt)
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
  const sections: string[] = [];
  const heading = 'Available tools — use tool_calls objects, never plain-text commands:';

  // --- Discovery (use to find and search) ---
  const discovery: string[] = [];
  if (availableTools.has('workspace-lister')) {
    discovery.push('- `workspace-lister({path?})`: list directory tree. Omit path for workspace root.');
  }
  if (availableTools.has('workspace-search')) {
    discovery.push('- `workspace-search({query})`: search file contents by keyword.');
  }
  if (availableTools.has('glob')) {
    discovery.push('- `glob({pattern?})`: find files by glob pattern, e.g. `src/**/*.ts`.');
  }
  if (availableTools.has('grep')) {
    discovery.push('- `grep({query})`: search plain text across all workspace files.');
  }
  if (availableTools.has('knowledge-search')) {
    discovery.push('- `knowledge-search({query})`: search imported workspace knowledge.');
  }
  if (availableTools.has('web-search')) {
    discovery.push('- `web-search({query})`: search the public web.');
  }
  if (availableTools.has('web-fetch')) {
    discovery.push('- `web-fetch({url})`: fetch a remote URL.');
  }
  if (discovery.length) sections.push('Discovery:\n' + discovery.join('\n'));

  // --- Reading (always call before modifying) ---
  const reading: string[] = [];
  if (availableTools.has('read')) {
    reading.push('- `read({filePath})`: read exact file contents.');
  }
  if (availableTools.has('file-reader')) {
    reading.push('- `file-reader({path})`: read a file from the app or workspace.');
  }
  if (reading.length) sections.push('Reading (always call before modifying):\n' + reading.join('\n'));

  // --- Writing (use after reading) ---
  const writing: string[] = [];
  if (availableTools.has('write')) {
    writing.push(
      '- `write({filePath, content})`: create or fully overwrite a file. Content must be the complete new file, and `write` cannot infer content from a path-only call.'
    );
  }
  if (availableTools.has('edit')) {
    writing.push(
      '- `edit({filePath, startLine, endLine, newText})`: replace lines startLine..endLine (1-based inclusive). ' +
        '`edit({filePath, line, operation: "insert_after", newText})`: insert after line (0 = prepend). ' +
        'Always read first to get line numbers. Use write if most of the file changes.'
    );
  }
  if (writing.length) sections.push('Writing (use after reading):\n' + writing.join('\n'));

  // --- Execution ---
  const execution: string[] = [];
  if (availableTools.has('bash')) {
    execution.push('- `bash({command})`: run a bash command. Prefer for validation, not broad exploration.');
  }
  if (availableTools.has('powershell')) {
    execution.push('- `powershell({command})`: run a PowerShell command. Prefer for validation, not broad exploration.');
  }
  if (availableTools.has('monitor')) {
    execution.push('- `monitor({command})`: run a long-lived command in the background. Output captured in a task.');
  }
  if (availableTools.has('code-runner')) {
    execution.push('- `code-runner({code})`: run a JavaScript snippet in a sandbox.');
  }
  if (execution.length) sections.push('Execution:\n' + execution.join('\n'));

  // --- Code intelligence ---
  const codeIntel: string[] = [];
  if (availableTools.has('lsp')) {
    codeIntel.push(
      "- `lsp({action, symbol?})`: action='definition' for defs, 'references' for usages, 'diagnostics' for errors."
    );
  }
  if (availableTools.has('notebook-edit')) {
    codeIntel.push('- `notebook-edit({filePath, cellIndex, source})`: replace a notebook cell by zero-based index.');
  }
  if (codeIntel.length) sections.push('Code intelligence:\n' + codeIntel.join('\n'));

  // --- Planning & Tasks (use for multi-step work) ---
  const planning: string[] = [];
  if (availableTools.has('enter-plan-mode')) {
    planning.push('- `enter-plan-mode()`: activate structured planning for multi-step tasks.');
  }
  if (availableTools.has('exit-plan-mode')) {
    planning.push('- `exit-plan-mode({summary?})`: deactivate plan mode. Pass summary of accomplishments.');
  }
  if (availableTools.has('task-create')) {
    planning.push('- `task-create({title, details?})`: create a tracked task.');
  }
  if (availableTools.has('task-update')) {
    planning.push(
      '- `task-update({taskId, status?, ...})`: set "in_progress" when starting, "completed" when done, "cancelled" if unnecessary, "failed" if blocked.'
    );
  }
  if (availableTools.has('task-stop')) {
    planning.push('- `task-stop({taskId})`: cancel a task no longer needed.');
  }
  if (availableTools.has('task-list')) {
    planning.push('- `task-list()`: list all tracked tasks.');
  }
  if (availableTools.has('task-get')) {
    planning.push('- `task-get({taskId})`: fetch a tracked task by id.');
  }
  if (availableTools.has('task-output')) {
    planning.push('- `task-output({taskId})`: read the output file for a tracked task.');
  }
  if (availableTools.has('todo-write')) {
    planning.push('- `todo-write({items: string[]})`: bulk-create tasks from a checklist.');
  }
  if (planning.length) sections.push('Planning & Tasks (use for multi-step work):\n' + planning.join('\n'));

  // --- Scheduling ---
  const scheduling: string[] = [];
  if (availableTools.has('cron-create')) {
    scheduling.push("- `cron-create({title, prompt, kind, intervalSeconds?, runAt?})`: schedule a prompt. Kind must be 'once' or 'interval'.");
  }
  if (availableTools.has('cron-delete')) {
    scheduling.push('- `cron-delete({scheduleId})`: cancel a scheduled prompt.');
  }
  if (availableTools.has('cron-list')) {
    scheduling.push('- `cron-list()`: list all scheduled prompts.');
  }
  if (scheduling.length) sections.push('Scheduling:\n' + scheduling.join('\n'));

  // --- Agents & Teams ---
  const agents: string[] = [];
  if (availableTools.has('agent')) {
    agents.push('- `agent({prompt})`: launch a background agent for complex subtasks.');
  }
  if (availableTools.has('send-message')) {
    agents.push('- `send-message({sessionId, message})`: continue an agent session with more instructions.');
  }
  if (availableTools.has('team-create')) {
    agents.push('- `team-create({title, agentPrompts})`: create agents working in parallel.');
  }
  if (availableTools.has('team-delete')) {
    agents.push('- `team-delete({teamId})`: archive a completed team.');
  }
  if (agents.length) sections.push('Agents & Teams:\n' + agents.join('\n'));

  // --- Worktrees ---
  const worktrees: string[] = [];
  if (availableTools.has('enter-worktree')) {
    worktrees.push('- `enter-worktree({repoRoot, branch})`: create an isolated git worktree for parallel work.');
  }
  if (availableTools.has('exit-worktree')) {
    worktrees.push('- `exit-worktree({sessionId})`: leave and clean up a worktree session.');
  }
  if (worktrees.length) sections.push('Worktrees:\n' + worktrees.join('\n'));

  // --- MCP ---
  const mcp: string[] = [];
  if (availableTools.has('list-mcp-resources')) {
    mcp.push('- `list-mcp-resources()`: list MCP resources.');
  }
  if (availableTools.has('read-mcp-resource')) {
    mcp.push('- `read-mcp-resource({resource})`: read an MCP resource by label or path.');
  }
  if (mcp.length) sections.push('MCP:\n' + mcp.join('\n'));

  // --- Meta ---
  const meta: string[] = [];
  if (availableTools.has('ask-user-question')) {
    meta.push('- `ask-user-question({question, options})`: ask the user a clarifying question.');
  }
  if (availableTools.has('tool-search')) {
    meta.push('- `tool-search({query})`: discover available tools and skills by keyword.');
  }
  if (availableTools.has('skill')) {
    meta.push('- `skill({skillId, prompt?})`: invoke a registered skill.');
  }
  if (meta.length) sections.push('Meta:\n' + meta.join('\n'));

  return heading + '\n\n' + sections.join('\n\n');
}

function buildNativeSkillReferencePrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return 'Available skills:\n- _No available skills_';
  }

  return [
    'Available skills:',
    '- If another system message already activates a specific skill, follow that active skill prompt over this catalog.',
    '- Otherwise, internally adopt the single best matching skill behavior for this turn.',
    ...skills.map(
      (skill) => `- \`${skill.id}\` (${skill.title}): ${skill.description}`
    )
  ].join('\n');
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
  const inputSummary = invocation.inputSummary ?? '';

  switch (invocation.toolId) {
    case 'edit':
      return [
        '- Read the file first to get exact line numbers, then retry with `{ filePath, startLine, endLine, newText }`.',
        '- If most of the file needs to change, switch to `write` with the full replacement content.'
      ];
    case 'write': {
      const hasFilePath = /"(?:filePath|path)"\s*:/.test(inputSummary);
      const hasContent = /"content"\s*:/.test(inputSummary);

      if (hasFilePath && !hasContent) {
        return [
          '- `write` is a single-call file creation or overwrite tool. It cannot infer file contents from `filePath` alone.',
          '- Retry with one JSON object that includes both `filePath` and full `content`, for example `{ "filePath": "index.html", "content": "<!doctype html>..." }`.',
          '- If you only need to change an existing file, read it first and then use `edit` for the targeted patch.'
        ];
      }

      if (!hasFilePath && hasContent) {
        return [
          '- Retry with both `filePath` and full `content` in the same `write` call.',
          '- If the target path is uncertain, use `workspace-search`, `glob`, or `workspace-lister` first.'
        ];
      }

      return [
        '- Call `write` with JSON arguments containing both `filePath` and full `content` in the same call.',
        '- If the target path is uncertain, use `workspace-search`, `glob`, or `workspace-lister` first.'
      ];
    }
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

function isCloudHostedModel(model: string): boolean {
  return /(?:^|[:/.-])cloud(?:$|[:/.-])|(?:^|[:/.-][A-Za-z0-9]+)-cloud(?:$|[:/.-])/i.test(
    model.trim()
  );
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
  mode: ImageGenerationRequest['mode'];
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

const THINKING_BLOCK_PATTERN =
  /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi;
const THINKING_TAG_PATTERN = /<\/?(?:think|thinking|reasoning)\b[^>]*>/gi;

function sanitizeTextCommandRecoveryContent(content: string): string {
  return content
    .replace(THINKING_BLOCK_PATTERN, '\n')
    .replace(THINKING_TAG_PATTERN, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function composePersistentAssistantContent(input: {
  content: string;
  thinking?: string | null;
}): string {
  const content = input.content.trim();
  const thinking = input.thinking?.trim() ?? '';

  if (!thinking) {
    return content;
  }

  return content
    ? `<think>\n${thinking}\n</think>\n\n${content}`
    : `<think>\n${thinking}\n</think>`;
}

function decodeTextCommandQuotedValue(value: string): string | null {
  const quote = value[0];

  if ((quote !== '"' && quote !== "'") || value.length < 2) {
    return null;
  }

  let decoded = '';

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) {
      break;
    }

    if (char === quote) {
      return index === value.length - 1 ? decoded : null;
    }

    if (char === '\\') {
      const next = value[index + 1];

      if (next === undefined) {
        decoded += '\\';
        continue;
      }

      if (next === quote || next === '\\') {
        decoded += next;
        index += 1;
        continue;
      }

      if (next === 'n') {
        decoded += '\n';
        index += 1;
        continue;
      }

      if (next === 'r') {
        decoded += '\r';
        index += 1;
        continue;
      }

      if (next === 't') {
        decoded += '\t';
        index += 1;
        continue;
      }

      decoded += '\\';
      continue;
    }

    decoded += char;
  }

  return null;
}

function coerceTextCommandValue(value: string): unknown {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  const decodedQuotedValue = decodeTextCommandQuotedValue(trimmed);

  if (decodedQuotedValue !== null) {
    return decodedQuotedValue;
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }

  if (/^null$/i.test(trimmed)) {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return parseJsonishRecord(trimmed) ?? trimmed;
  }

  return trimmed;
}

function parseParenthesizedTextCommandArguments(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  const parsedArguments: Record<string, unknown> = {};
  let index = 0;

  while (index < trimmed.length) {
    while (index < trimmed.length && /[\s,]/.test(trimmed[index] ?? '')) {
      index += 1;
    }

    if (index >= trimmed.length) {
      break;
    }

    const keyMatch = /^[A-Za-z_][\w-]*/.exec(trimmed.slice(index));

    if (!keyMatch) {
      return null;
    }

    const key = keyMatch[0];
    index += key.length;

    while (index < trimmed.length && /\s/.test(trimmed[index] ?? '')) {
      index += 1;
    }

    const separator = trimmed[index];

    if (separator !== '=' && separator !== ':') {
      return null;
    }

    index += 1;

    while (index < trimmed.length && /\s/.test(trimmed[index] ?? '')) {
      index += 1;
    }

    if (index >= trimmed.length) {
      return null;
    }

    const valueStart = index;
    let inQuote: '"' | "'" | null = null;
    let braceDepth = 0;
    let bracketDepth = 0;

    while (index < trimmed.length) {
      const char = trimmed[index];

      if (char === undefined) {
        break;
      }

      if (inQuote) {
        if (char === '\\') {
          index += 2;
          continue;
        }

        if (char === inQuote) {
          inQuote = null;
        }

        index += 1;
        continue;
      }

      if (char === '"' || char === "'") {
        inQuote = char;
        index += 1;
        continue;
      }

      if (char === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }

      if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        continue;
      }

      if (char === '[') {
        bracketDepth += 1;
        index += 1;
        continue;
      }

      if (char === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        index += 1;
        continue;
      }

      if (char === ',' && braceDepth === 0 && bracketDepth === 0) {
        break;
      }

      index += 1;
    }

    const rawValue = trimmed.slice(valueStart, index).trim();

    if (!rawValue) {
      return null;
    }

    parsedArguments[key] = coerceTextCommandValue(rawValue);

    if (trimmed[index] === ',') {
      index += 1;
    }
  }

  return parsedArguments;
}

function extractSlashCommandAlias(value: string): string | null {
  const match = value.trim().match(/^\/([\w-]+)/);
  return match?.[1] ?? null;
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

/**
 * Fallback parser for models that output slash commands as plain text instead of native tool_calls.
 * This is only used in explicit recovery rounds marked by the bridge.
 */
function extractTextCommandToolCalls(content: string): {
  cleanedContent: string;
  toolCalls: InlineMarkupToolCall[];
} {
  const toolCalls: InlineMarkupToolCall[] = [];

  const commandMap: Record<string, string> = {
    'plan-on': 'enter-plan-mode',
    'plan-off': 'exit-plan-mode',
    'task-create': 'task-create',
    'task-update': 'task-update',
    'task-list': 'task-list',
    'task-stop': 'task-stop',
    'todo': 'todo-write',
    'ls': 'workspace-lister',
    'workspace-lister': 'workspace-lister',
    'workspace-search': 'workspace-search',
    'read': 'file-reader',
    'file-reader': 'file-reader',
    'write': 'write',
    'edit': 'edit',
    'grep': 'workspace-search',
    'glob': 'glob',
    'bash': 'bash',
    'powershell': 'powershell',
    'code-runner': 'code-runner',
    'web': 'web-search',
    'web-search': 'web-search',
    'web-fetch': 'web-fetch',
    'knowledge': 'knowledge-search',
    'knowledge-search': 'knowledge-search',
    'agent': 'agent',
    'send-message': 'send-message',
    'team-create': 'team-create',
    'team-delete': 'team-delete',
    'skill': 'skill',
    'tool-search': 'tool-search',
    'lsp': 'lsp',
    'monitor': 'monitor',
    'cron-create': 'cron-create',
    'cron-delete': 'cron-delete',
    'cron-list': 'cron-list',
    'worktree-enter': 'enter-worktree',
    'worktree-exit': 'exit-worktree',
    'ask-user-question': 'ask-user-question',
    'mcp-list': 'list-mcp-resources',
    'mcp-read': 'read-mcp-resource'
  };

  // Map plain-arg tool names to their primary parameter
  const argMapping: Record<string, string> = {
    'file-reader': 'path',
    'write': 'filePath',
    'edit': 'filePath',
    'workspace-search': 'query',
    'knowledge-search': 'query',
    'web-search': 'query',
    'web-fetch': 'url',
    'workspace-lister': 'path',
    'glob': 'pattern',
    'bash': 'command',
    'powershell': 'command',
    'monitor': 'command',
    'code-runner': 'code',
    'lsp': 'symbol',
    'skill': 'skillId',
    'todo-write': 'items'
  };

  let remaining = sanitizeTextCommandRecoveryContent(content);

  // Phase 1: Extract /command with fenced code blocks
  // Matches: /powershell\n```lang\n...\n``` or /bash\n```sh\n...\n```
  const CODE_BLOCK_PATTERN = /(?:^|\n)\s*\/([\w-]+)\s*\n```[\w]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;

  while ((match = CODE_BLOCK_PATTERN.exec(remaining)) !== null) {
    const cmd = match[1] as string;
    const codeBlock = (match[2] as string).trim();
    const toolName = commandMap[cmd];
    if (!toolName || !codeBlock) continue;

    const param = argMapping[toolName] ?? 'prompt';
    const args: Record<string, unknown> = {};
    if (toolName === 'todo-write') {
      args.items = codeBlock.split('\n').map((s: string) => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
    } else if (toolName === 'edit') {
      args.filePath = codeBlock;
    } else {
      args[param] = codeBlock;
    }
    toolCalls.push({ toolName, arguments: args });
    remaining = remaining.replace(match[0], '');
    CODE_BLOCK_PATTERN.lastIndex = 0; // reset after content mutation
  }

  // Phase 2: Extract one-line /command invocations.
  const lines = remaining.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index] ?? '';
    const trimmedLine = originalLine.trim();

    if (!trimmedLine) {
      cleanedLines.push('');
      continue;
    }

    if (!trimmedLine.startsWith('/')) {
      cleanedLines.push(originalLine);
      continue;
    }

    const commandAlias = extractSlashCommandAlias(trimmedLine);
    const toolName = commandAlias ? commandMap[commandAlias] : null;

    if (!toolName) {
      cleanedLines.push(originalLine);
      continue;
    }

    const rawArgs = trimmedLine.slice(commandAlias!.length + 1).trim();
    let args: Record<string, unknown> = {};

    if (rawArgs.startsWith('(') && rawArgs.endsWith(')')) {
      const parsedArgs = parseParenthesizedTextCommandArguments(rawArgs.slice(1, -1));
      if (!parsedArgs) {
        cleanedLines.push(originalLine);
        continue;
      }
      args = parsedArgs;
    } else if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
      args = parseJsonishRecord(rawArgs) ?? { __raw: rawArgs };
    } else if (rawArgs) {
      const param = argMapping[toolName] ?? 'prompt';
      if (toolName === 'todo-write') {
        args.items = rawArgs
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      } else {
        args[param] = rawArgs;
      }
    }

    if (Object.keys(args).length === 0) {
      const nextNonBlankLine = lines
        .slice(index + 1)
        .map((line) => line.trim())
        .find(Boolean);
      const nextAlias = nextNonBlankLine ? extractSlashCommandAlias(nextNonBlankLine) : null;
      const nextToolName = nextAlias ? commandMap[nextAlias] : null;

      if (
        nextToolName === toolName &&
        nextNonBlankLine !== undefined &&
        /^(?:\/[\w-]+\s*(?:\(|\{)|\/[\w-]+\s+\S)/.test(nextNonBlankLine)
      ) {
        continue;
      }
    }

    toolCalls.push({ toolName, arguments: args });
  }

  return {
    cleanedContent: cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    toolCalls
  };
}

function parseJsonToolCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string') {
    return {};
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  return parseJsonishRecord(trimmed) ?? { __raw: trimmed };
}

function extractJsonTextToolCalls(content: string): {
  cleanedContent: string;
  toolCalls: InlineMarkupToolCall[];
} {
  const normalizedContent = sanitizeTextCommandRecoveryContent(content);

  if (!normalizedContent) {
    return { cleanedContent: '', toolCalls: [] };
  }

  const fencedMatch = normalizedContent.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const rawPayload = (fencedMatch?.[1] ?? normalizedContent).trim();
  const jsonPayload = rawPayload.replace(/^tool_calls\b\s*:?\s*/i, '').trim();

  if (!jsonPayload.startsWith('[') || !jsonPayload.endsWith(']')) {
    return {
      cleanedContent: normalizedContent,
      toolCalls: []
    };
  }

  try {
    const parsed = JSON.parse(jsonPayload) as unknown;

    if (!Array.isArray(parsed)) {
      return {
        cleanedContent: normalizedContent,
        toolCalls: []
      };
    }

    const toolCalls = parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return [];
      }

      const itemRecord = item as Record<string, unknown>;
      const functionRecord =
        typeof itemRecord.function === 'object' &&
        itemRecord.function !== null &&
        !Array.isArray(itemRecord.function)
          ? (itemRecord.function as Record<string, unknown>)
          : itemRecord;
      const toolName =
        typeof functionRecord.name === 'string' ? functionRecord.name.trim() : null;

      if (!toolName) {
        return [];
      }

      return [
        {
          toolName,
          arguments: parseJsonToolCallArguments(
            functionRecord.arguments ?? functionRecord.args
          )
        }
      ];
    });

    if (toolCalls.length === 0) {
      return {
        cleanedContent: normalizedContent,
        toolCalls: []
      };
    }

    return {
      cleanedContent: '',
      toolCalls
    };
  } catch {
    return {
      cleanedContent: normalizedContent,
      toolCalls: []
    };
  }
}

function shouldRecoverTextCommandToolCalls(messages: OllamaChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'system') continue;
    return message.content.includes(TEXT_COMMAND_RECOVERY_MARKER);
  }

  return false;
}

function buildInlineToolExecutionResultPrompt(toolOutputs: string[]): string {
  return [
    TEXT_COMMAND_RECOVERY_MARKER,
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

  listMessagesForUi(conversationId: string) {
    return this.decorateMessages(this.repository.listMessages(conversationId), {
      includeArtifacts: false
    });
  }

  getMessage(messageId: string) {
    const message = this.repository.getMessage(messageId);
    return message
      ? (this.decorateMessages([message])[0] ?? message)
      : null;
  }

  listTools(): ToolDefinition[] {
    return this.toolDispatcher.listDefinitions();
  }

  listSkills(): SkillDefinition[] {
    return this.skillRegistry.list();
  }

  createSkill(input: CreateSkillInput): SkillDefinition {
    const skill = this.skillRegistry.createSkill(input);
    this.logger.info({ skillId: skill.id }, 'Created user skill');
    return skill;
  }

  updateSkill(input: UpdateSkillInput): SkillDefinition {
    const skill = this.skillRegistry.updateSkill(input);
    this.logger.info({ skillId: skill.id }, 'Updated user skill');
    return skill;
  }

  deleteSkill(input: DeleteSkillInput): void {
    this.skillRegistry.deleteSkill(input.skillId);
    this.logger.info({ skillId: input.skillId }, 'Deleted user skill');
  }

  listKnowledgeDocuments(workspaceId: string): KnowledgeDocument[] {
    return this.ragService.listWorkspaceDocuments(workspaceId);
  }

  deleteConversation(conversationId: string) {
    const conversation = this.repository.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} was not found.`);
    }

    this.generationRepository?.deleteJobsByConversationId(conversationId);
    this.repository.deleteConversation(conversationId);
    this.logger.info({ conversationId }, 'Deleted conversation');
  }

  pinMessage(messageId: string, pinned: boolean): StoredMessage {
    const message = this.repository.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} was not found.`);
    }

    this.turnMetadataService.setMessagePinned(message.id, message.conversationId, pinned);
    return this.decorateMessage(message.id, { includeArtifacts: false });
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    const request = createWorkspaceInputSchema.parse(input);
    const rootPath = await this.resolveWorkspaceRootPath(request.rootPath);

    const existingWorkspace = this.repository.findWorkspaceByRootPath(rootPath);

    if (existingWorkspace) {
      throw new Error(
        `The folder is already connected to workspace "${existingWorkspace.name}".`
      );
    }

    const workspace = this.repository.createWorkspace({
      ...request,
      rootPath
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

  deleteWorkspace(workspaceId: string): void {
    const workspace = this.repository.getWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} was not found.`);
    }

    const all = this.repository.listWorkspaces();

    if (all.length <= 1) {
      throw new Error('Cannot delete the last workspace.');
    }

    this.generationRepository?.deleteJobsByWorkspaceId(workspaceId);
    this.repository.deleteWorkspace(workspaceId);
    this.logger.info({ workspaceId, name: workspace.name }, 'Deleted workspace');
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

    const isImage = isImageFilePath(normalizedPath);
    const isVideo = !isImage && isVideoFilePath(normalizedPath);

    if (!isImage && !isVideo) {
      throw new Error('Only image or video attachments can be previewed.');
    }

    const fileStat = await stat(normalizedPath);

    if (!fileStat.isFile()) {
      throw new Error(`Attachment path is not a file: ${normalizedPath}`);
    }

    const sizeCap = isVideo ? MAX_VIDEO_PREVIEW_BYTES : MAX_ATTACHMENT_PREVIEW_BYTES;

    if (fileStat.size > sizeCap) {
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
    const automaticGenerationPlan = await this.resolveAutomaticGenerationPlan({
      prompt: request.prompt,
      requestedModel: request.model,
      attachments: request.attachments ?? [],
      conversationId: conversation.id
    });

    if (automaticGenerationPlan) {
      if (!this.generationService) {
        throw new Error('Image generation is not available in this app context.');
      }

      const startedJob = await this.generationService.startImageJob({
        conversationId: conversation.id,
        prompt: automaticGenerationPlan.prompt,
        mode: automaticGenerationPlan.mode,
        referenceImages: automaticGenerationPlan.referenceImages
      });
      const startedGenerationJob = (
        typeof startedJob === 'object' && startedJob !== null && 'job' in startedJob
          ? startedJob.job
          : startedJob
      ) as GenerationJob;
      const touchedConversation = this.repository.touchConversation(conversation.id);
      const accepted = chatStartAcceptedSchema.parse({
        kind: 'generation',
        requestId: randomUUID(),
        conversation: touchedConversation,
        job: startedGenerationJob,
        model: startedGenerationJob.model
      });

      this.logger.info(
        {
          conversationId: touchedConversation.id,
          jobId: startedGenerationJob.id,
          mode: startedGenerationJob.mode,
          model: startedGenerationJob.model,
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
        emitEvent
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
    emitEvent: (event: ChatStreamEvent) => void
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
      importedKnowledge
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
    onThinkingDelta?: ((delta: string) => void) | undefined;
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
      ...(input.onThinkingDelta ? { onThinkingDelta: input.onThinkingDelta } : {}),
      ...(input.numCtx === undefined ? {} : { numCtx: input.numCtx }),
      ...(input.think === undefined ? {} : { think: input.think }),
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  private async resolveAutomaticGenerationPlan(input: {
    prompt: string;
    requestedModel?: string | undefined;
    attachments: MessageAttachment[];
    conversationId: string;
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

    if (looksLikeImagePromptAuthoringRequest(cleanedPrompt)) {
      return null;
    }

    const currentReferenceImages = input.attachments.filter(isImageAttachment);
    const wantsRestoreToPriorImageContext = looksLikeImageRestorePrompt(cleanedPrompt);

    if (currentReferenceImages.length > 0) {
      const explicitImageEdit =
        looksLikeImageEditPrompt(cleanedPrompt) || looksLikeTextToImagePrompt(cleanedPrompt);

      if (looksLikeImageAnalysisPrompt(cleanedPrompt) || !explicitImageEdit) {
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
      looksLikeImageFollowUpPrompt(cleanedPrompt)
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

    if (looksLikeTextToImagePrompt(cleanedPrompt)) {
      return {
        prompt: cleanedPrompt,
        mode: 'text-to-image',
        reason: 'text-to-image-auto-generation',
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
      workspaceRootConnected,
      explicitSkillId: directives.explicitSkillId,
      explicitToolId: directives.explicitToolId
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
      const cappedWindow = Math.max(
        1,
        Math.min(CLOUD_NUM_CTX_LIMIT, sessionRemainingTokens)
      );
      const cappedBasePromptBudget = Math.min(basePromptBudget, cappedWindow);
      const appliedHeadroom = Math.max(
        0,
        Math.min(targetHeadroom, Math.max(cappedWindow - cappedBasePromptBudget, 0))
      );

      return {
        numCtx: Math.max(1, Math.min(CLOUD_NUM_CTX_LIMIT, cappedBasePromptBudget + appliedHeadroom)),
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
      numCtx: Math.max(1, Math.min(resourceCap, basePromptBudget + appliedHeadroom)),
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
        toolInvocationCount: result.toolInvocations.length,
        contextSourceCount: result.contextSources.length,
        usage,
        capabilitySnapshot: this.getCapabilitySurfaceSnapshot(workspace?.id ?? null)
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
      availableSkills: this.skillRegistry.list(),
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
      toolInvocationCount: toolInvocations.length,
      contextSourceCount: context.sources.length,
      usage: initialUsage
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
    let thinking = '';
    let currentAssistantMessageId = accepted.assistantMessage.id;
    const activeTurn: ActiveAssistantTurn = {
      abortController: new AbortController(),
      cancelled: false
    };
    this.activeAssistantTurns.set(currentAssistantMessageId, activeTurn);
    this.queue.increment();

    const bindActiveAssistantMessage = (assistantMessageId: string) => {
      if (assistantMessageId === currentAssistantMessageId) {
        return;
      }

      this.activeAssistantTurns.delete(currentAssistantMessageId);
      this.activeAssistantTurns.set(assistantMessageId, activeTurn);
      currentAssistantMessageId = assistantMessageId;
    };

    const createStreamingAssistantLoopMessage = () => {
      const createdMessage = this.repository.createMessage({
        conversationId: accepted.conversation.id,
        role: 'assistant',
        content: '',
        attachments: [],
        status: 'streaming',
        correlationId: accepted.assistantMessage.correlationId,
        model: accepted.model
      });
      const decoratedMessage = this.decorateMessage(createdMessage.id) ?? createdMessage;

      this.emitAssistantMessageCreatedEvent({
        emitEvent: input.emitEvent,
        requestId: accepted.requestId,
        conversationId: accepted.conversation.id,
        message: decoratedMessage
      });
      bindActiveAssistantMessage(decoratedMessage.id);
      return decoratedMessage;
    };

    const emitStreamingAssistantSnapshot = (snapshot: {
      content: string;
      thinking: string;
      status: StoredMessage['status'];
      toolInvocationCount?: number;
      contextSourceCount?: number;
      capabilitySnapshot?: CapabilitySurfaceSnapshot;
    }) => {
      this.reportAssistantProgressSafely({
        emitEvent: input.emitEvent,
        requestId: accepted.requestId,
        conversationId: accepted.conversation.id,
        assistantMessageId: currentAssistantMessageId,
        content: composePersistentAssistantContent({
          content: snapshot.content,
          thinking: snapshot.thinking
        }),
        status: snapshot.status,
        model: accepted.model,
        ...(snapshot.toolInvocationCount === undefined
          ? {}
          : { toolInvocationCount: snapshot.toolInvocationCount }),
        ...(snapshot.contextSourceCount === undefined
          ? {}
          : { contextSourceCount: snapshot.contextSourceCount }),
        ...(snapshot.capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: snapshot.capabilitySnapshot })
      });
    };

    const commitNativeLoopAssistantRound = (snapshot: {
      content: string;
      thinking: string;
      capabilitySnapshot?: CapabilitySurfaceSnapshot;
    }) => {
      const persistedContent = composePersistentAssistantContent({
        content: snapshot.content,
        thinking: snapshot.thinking
      });

      if (!persistedContent.trim()) {
        return;
      }

      emitStreamingAssistantSnapshot({
        content: snapshot.content,
        thinking: snapshot.thinking,
        status: 'completed',
        toolInvocationCount: 0,
        contextSourceCount: 0,
        ...(snapshot.capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: snapshot.capabilitySnapshot })
      });
      content = '';
      thinking = '';
      createStreamingAssistantLoopMessage();
    };

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
      const nativeToolDefinitions = this.toolDispatcher.listOllamaToolDefinitions({
        workspaceRootPath: workspace?.rootPath ?? null
      });
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
      const allowInlineToolCallAutoRecovery =
        this.shouldAllowInlineToolCallAutoRecovery({
          prompt: input.routePlan.cleanedPrompt,
          routeDecision: input.routePlan.routeDecision,
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
          availableSkills: this.skillRegistry.list(),
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
            thinking: nativeToolThinking,
            toolInvocations: nativeToolInvocations,
            contextSources: nativeToolContextSources,
            capabilitySnapshot
          }) => {
            content = nativeToolContent;
            thinking = nativeToolThinking;
            toolInvocations = [...initialToolInvocations, ...nativeToolInvocations];
            toolContextSources = [...initialToolContextSources, ...nativeToolContextSources];
            emitStreamingAssistantSnapshot({
              content,
              thinking,
              status: 'streaming',
              toolInvocationCount: toolInvocations.length,
              contextSourceCount: mergeContextSources(context.sources, toolContextSources).length,
              ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot })
            });
          },
          onRoundCommitted: ({
            content: roundContent,
            thinking: roundThinking,
            capabilitySnapshot
          }) => {
            content = roundContent;
            thinking = roundThinking;
            commitNativeLoopAssistantRound({
              content: roundContent,
              thinking: roundThinking,
              ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot })
            });
          },
          signal: activeTurn.abortController.signal
        });

        content = nativeToolResult.content;
        thinking = nativeToolResult.thinking;
        toolInvocations = [...initialToolInvocations, ...nativeToolResult.toolInvocations];
        toolContextSources = [...initialToolContextSources, ...nativeToolResult.contextSources];
        routeTrace = this.createRouteTrace(input.routePlan.routeDecision, {
          usedWorkspacePrompt: context.observability.usedWorkspacePrompt,
          usedPinnedMessages: context.observability.usedPinnedMessages,
          usedRag: context.observability.usedRag,
          usedTools: toolInvocations.length > 0
        });

        const persistedContent = composePersistentAssistantContent({ content, thinking });
        const finalUsage = this.createUsageEstimateFromContext(
          context.usageEstimate.promptTokens,
          persistedContent
        );
        const finalContextSources = mergeContextSources(context.sources, toolContextSources);

        this.finalizeAssistantCompletionSafely({
          conversationId: accepted.conversation.id,
          assistantMessageId: currentAssistantMessageId,
          requestId: accepted.requestId,
          emitEvent: input.emitEvent,
          workspaceId: workspace?.id ?? null,
          content: persistedContent,
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
            assistantMessageId: currentAssistantMessageId,
            model: accepted.model,
            strategy: routeTrace.strategy,
            doneReason: nativeToolResult.doneReason,
            usage: finalUsage,
            toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
            contextSourceCount: finalContextSources.length,
            assistantContent: clipLoggedText(persistedContent)
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
        onThinkingDelta: (delta) => {
          thinking += delta;
          const persistedContent = composePersistentAssistantContent({ content, thinking });

          this.repository.updateMessage(currentAssistantMessageId, {
            content: persistedContent,
            status: 'streaming',
            model: accepted.model
          });
          this.emitAssistantUpdateEvent({
            emitEvent: input.emitEvent,
            requestId: accepted.requestId,
            assistantMessageId: currentAssistantMessageId,
            content: persistedContent,
            status: 'streaming',
            model: accepted.model
          });
        },
        onDelta: (delta) => {
          content += delta;
          const persistedContent = composePersistentAssistantContent({ content, thinking });

          this.repository.updateMessage(currentAssistantMessageId, {
            content: persistedContent,
            status: 'streaming',
            model: accepted.model
          });
          input.emitEvent({
            type: 'delta',
            requestId: accepted.requestId,
            assistantMessageId: currentAssistantMessageId,
            delta,
            content: persistedContent
          });
        }
      });
      thinking = result.thinking || thinking;
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
        conversationId: accepted.conversation.id,
        allowAutoToolExecution: allowInlineToolCallAutoRecovery
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
      const persistedContent = composePersistentAssistantContent({ content, thinking });
      const finalUsage = this.createUsageEstimateFromContext(
        context.usageEstimate.promptTokens,
        persistedContent
      );
      const finalContextSources = mergeContextSources(context.sources, toolContextSources);

      this.finalizeAssistantCompletionSafely({
        conversationId: accepted.conversation.id,
        assistantMessageId: currentAssistantMessageId,
        requestId: accepted.requestId,
        emitEvent: input.emitEvent,
        workspaceId: workspace?.id ?? null,
        content: persistedContent,
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
          assistantMessageId: currentAssistantMessageId,
          model: accepted.model,
          strategy: routeTrace.strategy,
          doneReason: inlineToolRecovery.doneReason,
          usage: finalUsage,
          toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
          contextSourceCount: finalContextSources.length,
          assistantContent: clipLoggedText(persistedContent)
        },
        'Completed assistant turn'
      );
    } catch (error) {
      if (this.isAbortError(error) && activeTurn.cancelled) {
        const persistedContent = composePersistentAssistantContent({ content, thinking });
        const cancelledUsage = this.createUsageEstimateFromContext(
          context.usageEstimate.promptTokens,
          persistedContent
        );

        this.logger.info(
          {
            requestId: accepted.requestId,
            conversationId: accepted.conversation.id,
            assistantMessageId: currentAssistantMessageId,
            assistantContent: clipLoggedText(persistedContent),
            usage: cancelledUsage
          },
          'Assistant turn cancelled by user'
        );

        const cancelledContextSources = mergeContextSources(context.sources, toolContextSources);
        this.finalizeAssistantCompletionSafely({
          conversationId: accepted.conversation.id,
          assistantMessageId: currentAssistantMessageId,
          requestId: accepted.requestId,
          emitEvent: input.emitEvent,
          workspaceId: workspace?.id ?? null,
          content: persistedContent,
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
      const persistedContent = composePersistentAssistantContent({ content, thinking });
      this.logger.error(
        {
          requestId: accepted.requestId,
          conversationId: accepted.conversation.id,
          error: message,
          strategy: routeTrace.strategy,
          toolInvocations: summarizeLoggedToolInvocations(toolInvocations),
          contextSourceCount: failedContextSources.length,
          assistantContent: clipLoggedText(persistedContent)
        },
        'Assistant turn failed'
      );

      this.repository.updateMessage(currentAssistantMessageId, {
        content: persistedContent,
        status: 'failed',
        model: accepted.model
      });
      this.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: currentAssistantMessageId,
        routeTrace,
        usage: this.createUsageEstimateFromContext(
          context.usageEstimate.promptTokens,
          persistedContent
        ),
        toolInvocations,
        contextSources: failedContextSources
      });
      input.emitEvent({
        type: 'error',
        requestId: accepted.requestId,
        assistantMessageId: currentAssistantMessageId,
        message,
        recoverable: true
      });
    } finally {
      this.activeAssistantTurns.delete(currentAssistantMessageId);
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
    allowAutoToolExecution?: boolean;
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
    const allowAutoToolExecution = input.allowAutoToolExecution ?? false;

    for (let round = 0; round < INLINE_TOOL_CALL_ROUND_LIMIT; round += 1) {
      let { cleanedContent, toolCalls } = extractInlineMarkupToolCalls(content);
      const allowTextCommandRecovery = shouldRecoverTextCommandToolCalls(messages);
      const allowRecoveredToolExecution =
        allowAutoToolExecution || allowTextCommandRecovery;
      const jsonTextToolCallResult =
        toolCalls.length === 0 ? extractJsonTextToolCalls(content) : null;
      const autoRecoverableTextCommandResult =
        toolCalls.length === 0 ? extractTextCommandToolCalls(content) : null;
      const shouldRecoverJsonTextToolCalls =
        allowRecoveredToolExecution &&
        jsonTextToolCallResult !== null &&
        jsonTextToolCallResult.toolCalls.length > 0 &&
        jsonTextToolCallResult.cleanedContent.length === 0;
      const shouldAutoRecoverTextCommands =
        allowAutoToolExecution &&
        autoRecoverableTextCommandResult !== null &&
        autoRecoverableTextCommandResult.toolCalls.length > 0 &&
        autoRecoverableTextCommandResult.cleanedContent.length === 0;
      const suppressedToolCalls =
        toolCalls.length > 0
          ? toolCalls
          : jsonTextToolCallResult?.toolCalls?.length
            ? jsonTextToolCallResult.toolCalls
            : autoRecoverableTextCommandResult?.toolCalls ?? [];

      if (!allowRecoveredToolExecution && suppressedToolCalls.length > 0) {
        this.logger.info(
          {
            conversationId: input.conversationId,
            model: input.model,
            round: round + 1,
            toolNames: suppressedToolCalls.map((toolCall) => toolCall.toolName)
          },
          'Ignored provider-emitted tool calls because tool use was not expected for this turn'
        );

        return {
          content,
          doneReason,
          toolInvocations,
          contextSources
        };
      }

      if (toolCalls.length === 0 && shouldRecoverJsonTextToolCalls) {
        toolCalls = jsonTextToolCallResult?.toolCalls ?? [];
        cleanedContent = jsonTextToolCallResult?.cleanedContent ?? '';
        this.logger.info(
          {
            conversationId: input.conversationId,
            model: input.model,
            round: round + 1,
            recoveryMode: 'json-tool_calls-output',
            toolNames: toolCalls.map((tc) => tc.toolName)
          },
          'Recovered text-command tool calls from provider response'
        );
      }

      // Fallback: recover slash commands in explicit recovery rounds or when the assistant
      // emitted command-only output instead of a final answer.
      if (toolCalls.length === 0 && (allowTextCommandRecovery || shouldAutoRecoverTextCommands)) {
        const textCommandResult =
          autoRecoverableTextCommandResult ?? extractTextCommandToolCalls(content);
        if (textCommandResult.toolCalls.length > 0) {
          toolCalls = textCommandResult.toolCalls;
          cleanedContent = textCommandResult.cleanedContent;
          this.logger.info(
            {
              conversationId: input.conversationId,
              model: input.model,
              round: round + 1,
              recoveryMode: allowTextCommandRecovery
                ? 'explicit-recovery-round'
                : 'command-only-output',
              toolNames: toolCalls.map((tc) => tc.toolName)
            },
            'Recovered text-command tool calls from provider response'
          );
        }
      }

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

    if (input.workspaceRootPath === null && looksLikeWorkspaceInspectionPrompt(input.prompt)) {
      return false;
    }

    return (
      NATIVE_TOOL_CALLING_PATTERN.test(input.prompt) ||
      looksLikeNativeFileMutationPrompt(input.prompt) ||
      (input.workspaceRootPath !== null && looksLikeCodingTaskPrompt(input.prompt)) ||
      (input.workspaceRootPath !== null && looksLikeRepositoryAnalysisPrompt(input.prompt)) ||
      NATIVE_TOOL_LOOP_SKILL_IDS.has(input.routeDecision.activeSkillId ?? '')
    );
  }

  private shouldAllowInlineToolCallAutoRecovery(input: {
    prompt: string;
    routeDecision: RouteDecision;
    workspaceRootPath: string | null;
  }): boolean {
    if (input.routeDecision.useTools) {
      return true;
    }

    if (NATIVE_TOOL_LOOP_SKILL_IDS.has(input.routeDecision.activeSkillId ?? '')) {
      return true;
    }

    if (input.workspaceRootPath === null) {
      return false;
    }

    return (
      looksLikeNativeFileMutationPrompt(input.prompt) ||
      looksLikeWorkspaceInspectionPrompt(input.prompt) ||
      looksLikeRepositoryAnalysisPrompt(input.prompt) ||
      looksLikeCodingTaskPrompt(input.prompt)
    );
  }

  private getCapabilitySurfaceSnapshot(workspaceId: string | null): CapabilitySurfaceSnapshot {
    const planContext = this.toolDispatcher.getPlanContext(workspaceId);
    return {
      capabilityTasks: planContext.tasks,
      capabilityPlanState: planContext.planState
    };
  }

  private didCapabilitySurfaceChange(toolInvocations: ToolInvocation[]): boolean {
    return toolInvocations.some((invocation) =>
      CAPABILITY_SURFACE_TOOL_IDS.has(invocation.toolId)
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
    toolInvocationCount?: number;
    toolInvocations?: ToolInvocation[];
    contextSourceCount?: number;
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
    capabilitySnapshot?: CapabilitySurfaceSnapshot;
  }): void {
    input.emitEvent({
      type: 'update',
      requestId: input.requestId,
      assistantMessageId: input.assistantMessageId,
      content: input.content,
      status: input.status,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.routeTrace === undefined ? {} : { routeTrace: input.routeTrace }),
      ...(input.toolInvocationCount === undefined && input.toolInvocations === undefined
        ? {}
        : {
            toolInvocationCount:
              input.toolInvocationCount ?? input.toolInvocations?.length ?? 0
          }),
      ...(input.toolInvocations === undefined ? {} : { toolInvocations: input.toolInvocations }),
      ...(input.contextSourceCount === undefined && input.contextSources === undefined
        ? {}
        : {
            contextSourceCount:
              input.contextSourceCount ?? input.contextSources?.length ?? 0
          }),
      ...(input.contextSources === undefined ? {} : { contextSources: input.contextSources }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.capabilitySnapshot === undefined
        ? {}
        : {
            capabilityTasks: input.capabilitySnapshot.capabilityTasks,
            capabilityPlanState: input.capabilitySnapshot.capabilityPlanState
      })
    });
  }

  private emitAssistantMessageCreatedEvent(input: {
    emitEvent: (event: ChatStreamEvent) => void;
    requestId: string;
    conversationId: string;
    message: StoredMessage;
  }): void {
    input.emitEvent({
      type: 'message-created',
      requestId: input.requestId,
      conversationId: input.conversationId,
      assistantMessageId: input.message.id,
      message: input.message
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
    toolInvocationCount?: number;
    toolInvocations?: ToolInvocation[];
    contextSourceCount?: number;
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
    capabilitySnapshot?: CapabilitySurfaceSnapshot;
  }): void {
    input.emitEvent({
      type: 'complete',
      requestId: input.requestId,
      assistantMessageId: input.assistantMessageId,
      content: input.content,
      doneReason: input.doneReason,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.routeTrace === undefined ? {} : { routeTrace: input.routeTrace }),
      ...(input.toolInvocationCount === undefined && input.toolInvocations === undefined
        ? {}
        : {
            toolInvocationCount:
              input.toolInvocationCount ?? input.toolInvocations?.length ?? 0
          }),
      ...(input.toolInvocations === undefined ? {} : { toolInvocations: input.toolInvocations }),
      ...(input.contextSourceCount === undefined && input.contextSources === undefined
        ? {}
        : {
            contextSourceCount:
              input.contextSourceCount ?? input.contextSources?.length ?? 0
          }),
      ...(input.contextSources === undefined ? {} : { contextSources: input.contextSources }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.capabilitySnapshot === undefined
        ? {}
        : {
            capabilityTasks: input.capabilitySnapshot.capabilityTasks,
            capabilityPlanState: input.capabilitySnapshot.capabilityPlanState
          })
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
    toolInvocationCount?: number;
    toolInvocations?: ToolInvocation[];
    contextSourceCount?: number;
    contextSources?: ContextSource[];
    usage?: MessageUsage | null;
    capabilitySnapshot?: CapabilitySurfaceSnapshot;
  }): void {
    const eventInput = {
      ...input,
      toolInvocationCount: input.toolInvocationCount ?? input.toolInvocations?.length ?? 0,
      contextSourceCount: input.contextSourceCount ?? input.contextSources?.length ?? 0
    };

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

    if (
      input.routeTrace != null &&
      (input.usage !== undefined ||
        input.toolInvocations !== undefined ||
        input.contextSources !== undefined)
    ) {
      this.saveAssistantTurnArtifactsSafely({
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        routeTrace: input.routeTrace,
        usage: input.usage ?? null,
        toolInvocations: input.toolInvocations ?? [],
        contextSources: input.contextSources ?? []
      });
    }

    try {
      this.emitAssistantUpdateEvent({
        emitEvent: input.emitEvent,
        requestId: input.requestId,
        assistantMessageId: input.assistantMessageId,
        content: input.content,
        status: input.status,
        toolInvocationCount: eventInput.toolInvocationCount,
        contextSourceCount: eventInput.contextSourceCount,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: input.capabilitySnapshot })
      });
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error)
        },
        'Unable to emit lightweight assistant progress payload'
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
    workspaceId: string | null;
    content: string;
    doneReason: string | null;
    model?: string | null;
    routeTrace: RouteTrace;
    usage: MessageUsage | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }): void {
    const toolInvocationCount = input.toolInvocations.length;
    const contextSourceCount = input.contextSources.length;
    const capabilitySnapshot = this.getCapabilitySurfaceSnapshot(input.workspaceId);

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
        toolInvocationCount,
        contextSourceCount,
        usage: input.usage,
        capabilitySnapshot
      });
      return;
    } catch (error) {
      this.logger.warn(
        {
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
          toolInvocationCount,
          contextSourceCount
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
        toolInvocationCount,
        contextSourceCount,
        ...(input.model === undefined ? {} : { model: input.model }),
        capabilitySnapshot
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
        looksLikeNativeFileMutationPrompt(input.prompt) ||
        looksLikeCodingTaskPrompt(input.prompt))
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
    availableSkills: SkillDefinition[],
    planContext?: { planState: import('@bridge/ipc/contracts').PlanState | null; tasks: import('@bridge/ipc/contracts').CapabilityTask[] }
  ): OllamaChatMessage[] {
    const firstNonSystemIndex = messages.findIndex((message) => message.role !== 'system');
    const guidanceParts = [
      NATIVE_TOOL_LOOP_SYSTEM_PROMPT,
      buildNativeToolReferencePrompt(toolDefinitions),
      buildNativeSkillReferencePrompt(availableSkills)
    ];

    // Conditionally inject plan mode guidance only when relevant
    const lastUserStr = messages.filter((m) => m.role === 'user').pop()?.content ?? '';
    const isPlanActive = planContext?.planState?.status === 'active';
    const hasExistingTasks = (planContext?.tasks?.length ?? 0) > 0;
    const looksLikeMultiStep = NATIVE_TOOL_CALLING_PATTERN.test(lastUserStr);
    if (isPlanActive || hasExistingTasks || looksLikeMultiStep) {
      guidanceParts.push(PLAN_MODE_NATIVE_TOOL_LOOP_SYSTEM_PROMPT);
    }

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
    availableSkills: SkillDefinition[];
    maxRounds: number;
    hardMaxRounds: number;
    roundExtension: number;
    onProgress?: ((input: {
      content: string;
      thinking: string;
      toolInvocations: ToolInvocation[];
      contextSources: ContextSource[];
      capabilitySnapshot?: CapabilitySurfaceSnapshot;
    }) => void) | undefined;
    onRoundCommitted?: ((input: {
      content: string;
      thinking: string;
      capabilitySnapshot?: CapabilitySurfaceSnapshot;
    }) => void) | undefined;
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    thinking: string;
    doneReason: string | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }> {
    let messages = this.injectNativeToolLoopGuidance(
      input.messages,
      input.workflowMode,
      input.includeRepositoryAnalysisGuidance,
      input.toolDefinitions,
      input.availableSkills,
      this.toolDispatcher.getPlanContext(input.workspaceId)
    );
    const toolInvocations: ToolInvocation[] = [];
    const contextSources: ContextSource[] = [];
    const hardMaxRounds = Math.max(input.maxRounds, input.hardMaxRounds);
    let currentMaxRounds = input.maxRounds;
    let lastRoundExtensionProgressIndex = 0;
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
      let roundThinking = '';
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
              input.onProgress?.({
                content: roundContent,
                thinking: roundThinking,
                toolInvocations: [...toolInvocations],
                contextSources: [...contextSources]
              });
            },
            onThinkingDelta: (delta) => {
              roundThinking += delta;
              input.onProgress?.({
                content: roundContent,
                thinking: roundThinking,
                toolInvocations: [...toolInvocations],
                contextSources: [...contextSources]
              });
            }
          });

      roundContent = completion.content;
      roundThinking = completion.thinking || roundThinking;
      input.onProgress?.({
        content: roundContent,
        thinking: roundThinking,
        toolInvocations: [...toolInvocations],
        contextSources: [...contextSources]
      });

      const completionToolCalls = completion.toolCalls ?? [];

      if (completionToolCalls.length === 0) {
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
          input.onRoundCommitted?.({
            content: roundContent,
            thinking: roundThinking
          });
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
          input.onRoundCommitted?.({
            content: roundContent,
            thinking: roundThinking
          });
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
          input.onRoundCommitted?.({
            content: roundContent,
            thinking: roundThinking
          });
          continue;
        }

        return {
          content: completion.content,
          thinking: roundThinking,
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
          tool_calls: completionToolCalls
        }
      ];

      let roundCapabilitySnapshot: CapabilitySurfaceSnapshot | undefined;
      for (const toolCall of completionToolCalls) {
        const toolResponse = await this.executeNativeToolCall({
          toolCall,
          workspaceRootPath: input.workspaceRootPath,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId
        });

        toolInvocations.push(...toolResponse.toolInvocations);
        contextSources.push(...toolResponse.contextSources);
        roundCapabilitySnapshot = this.didCapabilitySurfaceChange(toolResponse.toolInvocations)
          ? this.getCapabilitySurfaceSnapshot(input.workspaceId)
          : roundCapabilitySnapshot;
        input.onProgress?.({
          content: roundContent,
          thinking: roundThinking,
          toolInvocations: [...toolInvocations],
          contextSources: [...contextSources],
          ...(roundCapabilitySnapshot === undefined
            ? {}
            : { capabilitySnapshot: roundCapabilitySnapshot })
        });
        messages.push({
          role: 'tool',
          tool_name: toolCall.function.name,
          content: toolResponse.content
        });
      }

      input.onRoundCommitted?.({
        content: roundContent,
        thinking: roundThinking,
        ...(roundCapabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: roundCapabilitySnapshot })
      });
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
          ...(clipLoggedText(failedInvocation.inputSummary, 600)
            ? [`Failed arguments: ${clipLoggedText(failedInvocation.inputSummary, 600)}`]
            : []),
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

  private decorateMessages(
    messages: StoredMessage[],
    options?: { includeArtifacts?: boolean }
  ): StoredMessage[] {
    return this.turnMetadataService.decorateMessages(messages, {
      includeToolInvocations: options?.includeArtifacts ?? true,
      includeContextSources: options?.includeArtifacts ?? true
    });
  }

  private decorateMessage(
    messageId: string,
    options?: { includeArtifacts?: boolean }
  ): StoredMessage {
    const message = this.repository.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} was not found.`);
    }

    return this.decorateMessages([message], options)[0] ?? message;
  }

  private isKnownLocalFilePath(normalizedPath: string): boolean {
    return (
      this.previewAllowedPaths.has(normalizedPath) ||
      this.repository.hasAttachmentPath(normalizedPath) ||
      this.generationRepository?.hasKnownFilePath(normalizedPath) === true
    );
  }
}
