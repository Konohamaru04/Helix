import { describe, expect, it } from 'vitest';
import { buildConversationContext, buildRecentTurnContext } from '@bridge/context';

const baseMessage = {
  conversationId: '20000000-0000-4000-8000-000000000001',
  attachments: [],
  model: null,
  correlationId: null,
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

describe('buildConversationContext', () => {
  it('limits the number of included completed messages', () => {
    const result = buildRecentTurnContext(
      [
        {
          ...baseMessage,
          id: '10000000-0000-4000-8000-000000000001',
          role: 'user',
          content: 'first',
          status: 'completed'
        },
        {
          ...baseMessage,
          id: '10000000-0000-4000-8000-000000000002',
          role: 'assistant',
          content: 'second',
          status: 'completed'
        },
        {
          ...baseMessage,
          id: '10000000-0000-4000-8000-000000000003',
          role: 'assistant',
          content: 'ignored',
          status: 'failed'
        }
      ],
      1
    );

    expect(result.messages).toEqual([
      { role: 'assistant', content: 'second', imageAttachments: [] }
    ]);
    expect(result.observability.excludedCount).toBe(1);
  });

  it('assembles workspace prompts, skill prompts, pinned memory, and deduped sources', () => {
    const result = buildConversationContext({
      recentMessages: [
        {
          ...baseMessage,
          id: '10000000-0000-4000-8000-000000000004',
          role: 'user',
          content: 'Question with attachment',
          attachments: [
            {
              id: '30000000-0000-4000-8000-000000000001',
              fileName: 'diagram.png',
              filePath: 'E:\\OllamaDesktop\\diagram.png',
              mimeType: 'image/png',
              sizeBytes: 1024,
              extractedText: null,
              createdAt: '2026-04-08T00:00:00.000Z'
            }
          ],
          status: 'completed'
        }
      ],
      pinnedMessages: [
        {
          ...baseMessage,
          id: '10000000-0000-4000-8000-000000000005',
          role: 'assistant',
          content: 'Pinned reminder',
          status: 'completed'
        }
      ],
      retrievedSources: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          kind: 'document_chunk',
          label: 'Architecture.md',
          excerpt: 'Use the renderer only through preload.',
          sourcePath: 'E:\\OllamaDesktop\\docs\\architecture.md',
          documentId: '50000000-0000-4000-8000-000000000001',
          score: 0.12
        },
        {
          id: '40000000-0000-4000-8000-000000000002',
          kind: 'document_chunk',
          label: 'Architecture.md',
          excerpt: 'Use the renderer only through preload.',
          sourcePath: 'E:\\OllamaDesktop\\docs\\architecture.md',
          documentId: '50000000-0000-4000-8000-000000000001',
          score: 0.12
        }
      ],
      workspacePrompt: 'Keep answers local-first.',
      workspaceRootPath: 'E:\\OllamaDesktop',
      skillPrompt: 'Prefer grounded facts.',
      availableTools: [
        {
          id: 'workspace-search',
          title: 'Workspace Search',
          description: 'Search file names and file text inside the selected workspace.',
          command: '/workspace-search',
          kind: 'tool',
          permissionClass: 'none',
          availability: 'available',
          autoRoutable: true
        },
        {
          id: 'read',
          title: 'Read',
          description: 'Read an exact file before making changes.',
          command: '/read',
          kind: 'tool',
          permissionClass: 'none',
          availability: 'available',
          autoRoutable: true
        }
      ],
      availableSkills: [
        {
          id: 'builder',
          title: 'Builder Mode',
          description: 'Implement features and changes concretely.',
          prompt: 'You are in Builder Mode.',
          source: 'builtin'
        }
      ],
      latestUserPromptOverride: 'Question with attachment',
      memorySummary: '- User asked for architecture.\n- Assistant emphasized preload.',
      summarizedMessageIds: ['10000000-0000-4000-8000-000000000006'],
      excludedRecentMessageCount: 1,
      maxMessages: 10
    });

    expect(result.messages[0]?.content).toContain('Capability catalog');
    expect(result.messages[0]?.content).toContain('Available tools');
    expect(result.messages[0]?.content).toContain('`workspace-search` via `/workspace-search`');
    expect(result.messages[0]?.content).toContain('Available skills');
    expect(result.messages[0]?.content).toContain('`builder` (Builder Mode)');
    expect(result.messages[1]?.content).toContain('Workspace prompt');
    expect(result.messages[2]?.content).toContain('Active skill prompt');
    expect(result.messages[3]?.content).toContain('Pinned memory');
    expect(result.messages[4]?.content).toContain('[Source 2]');
    expect(result.messages[5]?.content).toContain('Summarized conversation memory');
    expect(result.messages.at(-1)?.content).toContain('# Prompt');
    expect(result.messages.at(-1)?.content).toContain('# Workspace');
    expect(result.messages.at(-1)?.content).toContain('`E:\\OllamaDesktop`');
    expect(result.messages.at(-1)?.imageAttachments).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.kind).toBe('pinned_message');
    expect(result.observability.usedWorkspacePrompt).toBe(true);
    expect(result.observability.usedSkillPrompt).toBe(true);
    expect(result.observability.usedPinnedMessages).toBe(true);
    expect(result.observability.usedMemorySummary).toBe(true);
    expect(result.observability.includedSummaryMessageIds).toEqual([
      '10000000-0000-4000-8000-000000000006'
    ]);
    expect(result.observability.usedRag).toBe(true);
    expect(result.observability.dedupedItemCount).toBe(1);
    expect(result.observability.excludedCount).toBe(1);
  });
});
