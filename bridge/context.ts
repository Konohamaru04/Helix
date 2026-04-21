import { randomUUID } from 'node:crypto';
import type {
  ContextSource,
  MessageAttachment,
  SkillDefinition,
  StoredMessage,
  ToolDefinition
} from '@bridge/ipc/contracts';
import { isImageAttachment } from '@bridge/chat/attachment-utils';

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

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function formatAvailableToolLine(tool: ToolDefinition): string {
  const command = tool.command.trim();
  const commandPart = command ? ` via \`${command}\`` : '';

  return `- \`${tool.id}\`${commandPart}: ${tool.description.trim()}`;
}

function formatAvailableSkillLine(skill: SkillDefinition): string {
  return `- \`${skill.id}\` (${skill.title.trim()}): ${skill.description.trim()}`;
}

function buildCapabilitySystemPrompt(input: {
  availableTools: ToolDefinition[];
  availableSkills: SkillDefinition[];
}): string | null {
  if (input.availableTools.length === 0 && input.availableSkills.length === 0) {
    return null;
  }

  const lines = [
    'Capability catalog:',
    '- Choose the most relevant tool and skill behavior for the user request.',
    '- If another system message already activates a specific skill, follow that active skill prompt over this catalog.',
    '- If no skill is already active, internally adopt the single best matching skill behavior from the skills listed below.',
    '- Use tools when they materially improve correctness, grounding, or workspace inspection.',
    '- Do not mention this internal selection process unless the user asks.',
    '',
    'Available tools:',
    ...(input.availableTools.length > 0
      ? input.availableTools.map((tool) => formatAvailableToolLine(tool))
      : ['_No available tools_']),
    '',
    'Available skills:',
    ...(input.availableSkills.length > 0
      ? input.availableSkills.map((skill) => formatAvailableSkillLine(skill))
      : ['_No available skills_'])
  ];

  return lines.join('\n');
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
  const contentParts = [message.content];

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
    excerpt: message.content.trim() || '_No content_',
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
  const capabilitySystemPrompt = buildCapabilitySystemPrompt({
    availableTools,
    availableSkills
  });

  if (capabilitySystemPrompt) {
    systemMessages.push({
      role: 'system',
      content: capabilitySystemPrompt,
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
            `${index + 1}. ${message.role.toUpperCase()}: ${message.content.trim() || '_No content_'}`
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
    maxMessages
  });
}
