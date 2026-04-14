import type {
  ChatRepository,
  ConversationMemorySummaryRecord
} from '@bridge/chat/repository';
import type { TurnMetadataService } from '@bridge/chat/turn-metadata';
import type { StoredMessage } from '@bridge/ipc/contracts';

const RAW_MEMORY_WINDOW = 12;
const MIN_MESSAGES_FOR_SUMMARY = 6;
const MAX_SUMMARY_LINES = 8;
const MAX_SUMMARY_LINE_CHARS = 220;

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function summarizeText(value: string, maxLength = MAX_SUMMARY_LINE_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeMessage(message: StoredMessage): string {
  const content = summarizeText(message.content || '_No content_');
  const toolSummary =
    message.toolInvocations && message.toolInvocations.length > 0
      ? ` Tool trace: ${message.toolInvocations
          .map((invocation) => `${invocation.displayName} (${invocation.status})`)
          .join(', ')}.`
      : '';

  if (message.role === 'user') {
    return `User asked: ${content}.${toolSummary}`;
  }

  if (message.role === 'assistant') {
    return `Assistant replied: ${content}.${toolSummary}`;
  }

  return `System note: ${content}.${toolSummary}`;
}

function buildSummaryLines(messages: StoredMessage[]): string[] {
  const lines: string[] = [];
  let currentUserPrompt: string | null = null;
  let currentAssistantReply: string | null = null;
  let currentToolTrace: string[] = [];

  const flushConversationTurn = () => {
    if (!currentUserPrompt && !currentAssistantReply) {
      return;
    }

    const segments: string[] = [];

    if (currentUserPrompt) {
      segments.push(`User: ${currentUserPrompt}`);
    }

    if (currentAssistantReply) {
      segments.push(`Assistant: ${currentAssistantReply}`);
    }

    if (currentToolTrace.length > 0) {
      segments.push(`Tools: ${currentToolTrace.join(', ')}`);
    }

    lines.push(summarizeText(segments.join(' ')));
    currentUserPrompt = null;
    currentAssistantReply = null;
    currentToolTrace = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      flushConversationTurn();
      currentUserPrompt = summarizeText(message.content || '_No content_');
      continue;
    }

    if (message.role === 'assistant') {
      currentAssistantReply = summarizeText(message.content || '_No content_');
      const toolInvocations = message.toolInvocations ?? [];

      if (toolInvocations.length > 0) {
        currentToolTrace = [
          ...currentToolTrace,
          ...toolInvocations.map(
            (invocation) => `${invocation.displayName} (${invocation.status})`
          )
        ];
      }

      continue;
    }

    flushConversationTurn();
    lines.push(summarizeMessage(message));
  }

  flushConversationTurn();
  return lines;
}

function buildSummaryText(messages: StoredMessage[]): string {
  const lines = buildSummaryLines(messages);

  if (lines.length <= MAX_SUMMARY_LINES) {
    return lines.map((line) => `- ${line}`).join('\n');
  }

  const headCount = Math.max(2, Math.floor(MAX_SUMMARY_LINES / 2));
  const tailCount = Math.max(2, MAX_SUMMARY_LINES - headCount - 1);
  const headLines = lines.slice(0, headCount).map((line) => `- ${line}`);
  const tailLines = lines.slice(-tailCount).map((line) => `- ${line}`);
  const skippedCount = Math.max(lines.length - headCount - tailCount, 0);

  return [
    ...headLines,
    `- ${skippedCount} earlier summarized turn${skippedCount === 1 ? '' : 's'} omitted for brevity.`,
    ...tailLines
  ].join('\n');
}

export interface ConversationMemoryContext {
  recentMessages: StoredMessage[];
  summaryText: string | null;
  summarizedMessageIds: string[];
  excludedMessageCount: number;
}

export class MemoryService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly turnMetadataService: TurnMetadataService
  ) {}

  listPinnedMessages(conversationId: string): StoredMessage[] {
    const pinnedMessageIds = this.turnMetadataService.listPinnedMessageIds(conversationId);
    const messages = this.turnMetadataService.decorateMessages(
      this.repository.listMessages(conversationId)
    );

    return messages.filter((message) => pinnedMessageIds.has(message.id));
  }

  buildConversationMemoryContext(
    conversationId: string,
    messages: StoredMessage[]
  ): ConversationMemoryContext {
    const pinnedMessageIds = this.turnMetadataService.listPinnedMessageIds(conversationId);
    const eligibleMessages = messages.filter(
      (message) =>
        message.status === 'completed' &&
        !pinnedMessageIds.has(message.id) &&
        (message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    );

    if (eligibleMessages.length <= RAW_MEMORY_WINDOW + MIN_MESSAGES_FOR_SUMMARY) {
      this.repository.clearConversationMemorySummary(conversationId);

      return {
        recentMessages: messages,
        summaryText: null,
        summarizedMessageIds: [],
        excludedMessageCount: 0
      };
    }

    const summarizedMessages = eligibleMessages.slice(0, -RAW_MEMORY_WINDOW);
    const summarizedMessageIds = summarizedMessages.map((message) => message.id);
    const latestSummarizedMessage = summarizedMessages.at(-1);

    if (!latestSummarizedMessage) {
      return {
        recentMessages: messages,
        summaryText: null,
        summarizedMessageIds: [],
        excludedMessageCount: 0
      };
    }

    const summaryRecord = this.ensureConversationSummary(
      conversationId,
      summarizedMessages,
      latestSummarizedMessage.id
    );
    const summarizedMessageIdSet = new Set(summarizedMessageIds);
    const recentMessages = messages.filter((message) => !summarizedMessageIdSet.has(message.id));

    return {
      recentMessages,
      summaryText: summaryRecord.summaryText,
      summarizedMessageIds,
      excludedMessageCount: summarizedMessageIds.length
    };
  }

  private ensureConversationSummary(
    conversationId: string,
    summarizedMessages: StoredMessage[],
    uptoMessageId: string
  ): ConversationMemorySummaryRecord {
    const existingSummary = this.repository.getConversationMemorySummary(conversationId);

    if (
      existingSummary &&
      existingSummary.uptoMessageId === uptoMessageId &&
      existingSummary.messageCount === summarizedMessages.length
    ) {
      return existingSummary;
    }

    const summaryText = buildSummaryText(summarizedMessages);

    return this.repository.upsertConversationMemorySummary({
      conversationId,
      uptoMessageId,
      messageCount: summarizedMessages.length,
      summaryText,
      tokenEstimate: estimateTokens(summaryText)
    });
  }
}
