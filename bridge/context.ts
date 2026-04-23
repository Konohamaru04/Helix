import { randomUUID } from 'node:crypto';
import type {
  ContextSource,
  MessageAttachment,
  SkillDefinition,
  StoredMessage,
  ToolDefinition
} from '@bridge/ipc/contracts';
import { isImageAttachment } from '@bridge/chat/attachment-utils';
import { buildPrimarySystemPrompt } from '@bridge/system-prompt';

export interface ContextChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  imageAttachments: MessageAttachment[];
}

export interface ContextAssemblyResult {
  messages: ContextChatMessage[];
  sources: ContextSource[];
  observability: {
    includedMessageIds: string[];
    includedPinnedMessageIds: string[];
    includedSummaryMessageIds: string[];
    includedDocumentIds: string[];
    excludedCount: number;
    dedupedItemCount: number;
    usedWorkspacePrompt: boolean;
    usedSkillPrompt: boolean;
    usedPinnedMessages: boolean;
    usedMemorySummary: boolean;
    usedRag: boolean;
  };
  usageEstimate: {
    promptTokens: number;
  };
}

const THINKING_BLOCK_PATTERN = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi;
const THINKING_TAG_PATTERN = /<\/?(?:think|thinking|reasoning)\b[^>]*>/gi;

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function stripAssistantThinkingContent(content: string): string {
  return content
    .replace(THINKING_BLOCK_PATTERN, '\n')
    .replace(THINKING_TAG_PATTERN, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getContextMessageContent(message: StoredMessage): string {
  return message.role === 'assistant'
    ? stripAssistantThinkingContent(message.content)
    : message.content;
}

function buildStructuredLatestUserPrompt(input: {
  prompt: string;
  workspaceRootPath: string | null;
}): string {
  const lines = ['# Prompt', input.prompt.trim() || '_No prompt provided_', ''];

  if (input.workspaceRootPath?.trim()) {
    lines.push('# Workspace', `\`${input.workspaceRootPath.trim()}\``, '');
  }

  return lines.join('\n');
}

function formatMessageWithAttachments(message: StoredMessage): ContextChatMessage {
  const imageAttachments = (message.attachments ?? []).filter((attachment) =>
    isImageAttachment(attachment)
  );
  const nonImageAttachments = (message.attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment)
  );
  const contentParts = [getContextMessageContent(message)];

  if (imageAttachments.length > 0) {
    const accessibleImages = imageAttachments.filter((attachment) => attachment.filePath !== null);
    const metadataOnlyImages = imageAttachments.filter((attachment) => attachment.filePath === null);

    if (accessibleImages.length > 0) {
      contentParts.push(
        '',
        `Attached image${accessibleImages.length === 1 ? '' : 's'}: ${accessibleImages
          .map((attachment) => attachment.fileName)
          .join(', ')}`
      );
    }

    if (metadataOnlyImages.length > 0) {
      contentParts.push(
        '',
        `Image attachment metadata only: ${metadataOnlyImages
          .map((attachment) => attachment.fileName)
          .join(', ')}`
      );
    }
  }

  if (nonImageAttachments.length > 0) {
    contentParts.push(
      '',
      'Attached files:',
      ...nonImageAttachments.map((attachment, index) => {
        const lines = [`${index + 1}. ${attachment.fileName}`];

        if (attachment.mimeType) {
          lines.push(`Type: ${attachment.mimeType}`);
        }

        if (attachment.sizeBytes !== null) {
          lines.push(`Size: ${attachment.sizeBytes} bytes`);
        }

        if (attachment.extractedText) {
          lines.push('Content:');
          lines.push(attachment.extractedText);
        } else {
          lines.push('Content: unavailable');
        }

        return lines.join('\n');
      })
    );
  }

  return {
    role: message.role,
    content: contentParts.filter(Boolean).join('\n'),
    imageAttachments
  };
}

export function buildConversationContext(input: {
  recentMessages: StoredMessage[];
  pinnedMessages: StoredMessage[];
  retrievedSources: ContextSource[];
  workspacePrompt: string | null;
  workspaceRootPath?: string | null;
  skillPrompt: string | null;
  planContextPrompt?: string | null;
  availableTools?: ToolDefinition[];
  availableSkills?: SkillDefinition[];
  latestUserPromptOverride?: string | null;
  memorySummary?: string | null;
  summarizedMessageIds?: string[];
  excludedRecentMessageCount?: number;
  maxMessages?: number;
  includeBaseSystemPrompt?: boolean;
}): ContextAssemblyResult {
  const maxMessages = input.maxMessages ?? 20;
  const eligibleRecentMessages = input.recentMessages.filter(
    (message) =>
      message.status === 'completed' &&
      (message.role === 'system' || message.role === 'user' || message.role === 'assistant')
  );
  const includedRecentMessages = eligibleRecentMessages.slice(-maxMessages);
  const pinnedMessageIds = new Set(input.pinnedMessages.map((message) => message.id));
  const pinnedMessagesForSystemBlock = input.pinnedMessages.filter(
    (message) => !includedRecentMessages.some((recentMessage) => recentMessage.id === message.id)
  );
  const pinnedSources = pinnedMessagesForSystemBlock.map((message) => ({
    id: randomUUID(),
    kind: 'pinned_message' as const,
    label: `${message.role.toUpperCase()} memory`,
    excerpt: getContextMessageContent(message).trim() || '_No content_',
    sourcePath: null,
    documentId: null,
    score: null
  }));
  const dedupedRetrievedSources = input.retrievedSources.filter(
    (source, index, allSources) =>
      allSources.findIndex(
        (candidate) =>
          candidate.label === source.label && candidate.excerpt === source.excerpt
      ) === index
  );
  const availableTools = (input.availableTools ?? []).filter(
    (tool) => tool.availability === 'available'
  );
  const availableSkills = input.availableSkills ?? [];
  const sources = [...pinnedSources, ...dedupedRetrievedSources];
  const systemMessages: ContextChatMessage[] = [];
  const includeBaseSystemPrompt = input.includeBaseSystemPrompt ?? true;

  if (includeBaseSystemPrompt) {
    systemMessages.push({
      role: 'system',
      content: buildPrimarySystemPrompt({
        availableTools,
        availableSkills
      }),
      imageAttachments: []
    });
  }

  if (input.workspacePrompt?.trim()) {
    systemMessages.push({
      role: 'system',
      content: `Workspace prompt:\n${input.workspacePrompt.trim()}`,
      imageAttachments: []
    });
  }

  if (input.skillPrompt?.trim()) {
    systemMessages.push({
      role: 'system',
      content: `Active skill prompt:\n${input.skillPrompt.trim()}`,
      imageAttachments: []
    });
  }

  if (input.planContextPrompt?.trim()) {
    systemMessages.push({
      role: 'system',
      content: input.planContextPrompt.trim(),
      imageAttachments: []
    });
  }

  if (pinnedMessagesForSystemBlock.length > 0) {
    systemMessages.push({
      role: 'system',
      content: [
        'Pinned memory:',
        ...pinnedMessagesForSystemBlock.map(
          (message, index) =>
            `${index + 1}. ${message.role.toUpperCase()}: ${getContextMessageContent(message).trim() || '_No content_'}`
        )
      ].join('\n'),
      imageAttachments: []
    });
  }

  if (sources.length > 0) {
    systemMessages.push({
      role: 'system',
      content: [
        'Workspace knowledge sources:',
        'Use these sources when relevant and cite them with references like [Source 1].',
        ...sources.map(
          (source, index) =>
            `[Source ${index + 1}] ${source.label}${source.sourcePath ? ` (${source.sourcePath})` : ''}\n${source.excerpt}`
        )
      ].join('\n\n'),
      imageAttachments: []
    });
  }

  if (input.memorySummary?.trim()) {
    systemMessages.push({
      role: 'system',
      content: `Summarized conversation memory:\n${input.memorySummary.trim()}`,
      imageAttachments: []
    });
  }

  const latestUserMessageId =
    [...includedRecentMessages].reverse().find((message) => message.role === 'user')?.id ?? null;
  const latestUserPrompt =
    input.latestUserPromptOverride?.trim() || null;
  const recentMessages = includedRecentMessages.map((message) =>
    formatMessageWithAttachments({
      ...message,
      content:
        message.role === 'user' && message.id === latestUserMessageId
          ? buildStructuredLatestUserPrompt({
              prompt: latestUserPrompt ?? message.content,
              workspaceRootPath: input.workspaceRootPath ?? null
            })
          : message.content
    })
  );
  const promptTokens = [...systemMessages, ...recentMessages].reduce(
    (total, message) => total + estimateTokens(message.content),
    0
  );

  return {
    messages: [...systemMessages, ...recentMessages],
    sources,
    observability: {
      includedMessageIds: includedRecentMessages.map((message) => message.id),
      includedPinnedMessageIds: [...pinnedMessageIds],
      includedSummaryMessageIds: input.summarizedMessageIds ?? [],
      includedDocumentIds: sources
        .map((source) => source.documentId)
        .filter((documentId): documentId is string => Boolean(documentId)),
      excludedCount:
        Math.max(eligibleRecentMessages.length - includedRecentMessages.length, 0) +
        (input.excludedRecentMessageCount ?? 0),
      dedupedItemCount:
        input.pinnedMessages.length -
        pinnedMessagesForSystemBlock.length +
        (input.retrievedSources.length - dedupedRetrievedSources.length),
      usedWorkspacePrompt: Boolean(input.workspacePrompt?.trim()),
      usedSkillPrompt: Boolean(input.skillPrompt?.trim()),
      usedPinnedMessages: pinnedMessagesForSystemBlock.length > 0,
      usedMemorySummary: Boolean(input.memorySummary?.trim()),
      usedRag: sources.length > 0
    },
    usageEstimate: {
      promptTokens
    }
  };
}

export function buildRecentTurnContext(
  messages: StoredMessage[],
  maxMessages = 20
): ContextAssemblyResult {
  return buildConversationContext({
    recentMessages: messages,
    pinnedMessages: [],
    retrievedSources: [],
    workspacePrompt: null,
    workspaceRootPath: null,
    skillPrompt: null,
    availableTools: [],
    availableSkills: [],
    latestUserPromptOverride: null,
    memorySummary: null,
    summarizedMessageIds: [],
    excludedRecentMessageCount: 0,
    maxMessages,
    includeBaseSystemPrompt: false
  });
}
