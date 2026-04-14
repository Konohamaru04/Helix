// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@renderer/components/message-bubble';

describe('MessageBubble', () => {
  beforeEach(() => {
    window.ollamaDesktop = {
      settings: {
        get: vi.fn(),
        update: vi.fn(),
        pickAdditionalModelsDirectory: vi.fn()
      },
      system: {
        getStatus: vi.fn()
      },
      generation: {
        startImage: vi.fn(),
        listImageModels: vi.fn(),
        listJobs: vi.fn(),
        cancelJob: vi.fn(),
        retryJob: vi.fn(),
        onJobEvent: vi.fn()
      },
      chat: {
        start: vi.fn(),
        pickAttachments: vi.fn(),
        editAndResend: vi.fn(),
        regenerateResponse: vi.fn(),
        cancelTurn: vi.fn(),
        deleteConversation: vi.fn(),
        pinMessage: vi.fn(),
        getAttachmentPreview: vi.fn().mockResolvedValue({
          dataUrl: 'data:image/png;base64,ZmFrZQ==',
          mimeType: 'image/png'
        }),
        openLocalPath: vi.fn(),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(),
        pickWorkspaceDirectory: vi.fn(),
        updateWorkspaceRoot: vi.fn(),
        listConversations: vi.fn(),
        searchConversations: vi.fn(),
        getConversationMessages: vi.fn(),
        listTools: vi.fn(),
        listSkills: vi.fn(),
        listKnowledgeDocuments: vi.fn(),
        importWorkspaceKnowledge: vi.fn(),
        importConversation: vi.fn(),
        exportConversation: vi.fn(),
        onStreamEvent: vi.fn()
      },
      capabilities: {
        listPermissions: vi.fn().mockResolvedValue([]),
        grantPermission: vi.fn(),
        revokePermission: vi.fn(),
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
        listSchedules: vi.fn().mockResolvedValue([]),
        listAgents: vi.fn().mockResolvedValue([]),
        listTeams: vi.fn().mockResolvedValue([]),
        listWorktrees: vi.fn().mockResolvedValue([]),
        getPlanState: vi.fn().mockResolvedValue({
          conversationId: null,
          status: 'inactive',
          summary: null,
          createdAt: null,
          updatedAt: null
        }),
        listAuditEvents: vi.fn().mockResolvedValue([])
      }
    };
  });

  it('renders markdown and lets users expand or collapse thinking sections', () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000099',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'assistant',
          content:
            '<think level="deep">Reasoning details</think>\n# Answer\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```',
          attachments: [],
          status: 'completed',
          model: 'llama3.2:latest',
          correlationId: null,
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
      />
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Reasoning details')).not.toBeInTheDocument();
    expect(screen.getByText('Answer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand thinking' }));

    expect(screen.getByText('Reasoning details')).toBeInTheDocument();
    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('shows image previews for local image attachments', async () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000100',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'user',
          content: 'Who is this?',
          attachments: [
            {
              id: '70000000-0000-4000-8000-000000000001',
              fileName: 'face.png',
              filePath: 'E:\\Images\\face.png',
              mimeType: 'image/png',
              sizeBytes: 2048,
              extractedText: null,
              createdAt: '2026-04-08T00:00:00.000Z'
            }
          ],
          status: 'completed',
          model: 'qwen3-vl:8b',
          correlationId: null,
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
      />
    );

    expect(await screen.findByRole('img', { name: 'face.png' })).toBeInTheDocument();
    expect(screen.getByText('Preview available')).toBeInTheDocument();
  });

  it('renders tool traces with expandable detailed output and keeps sources collapsed until expanded', () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000101',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'assistant',
          content: 'Final answer with provenance.',
          attachments: [],
          status: 'completed',
          model: 'llama3.2:latest',
          correlationId: null,
          routeTrace: {
            strategy: 'rag-tool',
            reason: 'workspace-knowledge-routing',
            confidence: 0.92,
            selectedModel: 'llama3.2:latest',
            fallbackModel: null,
            activeSkillId: 'grounded',
            activeToolId: 'file-reader',
            usedWorkspacePrompt: true,
            usedPinnedMessages: true,
            usedRag: true,
            usedTools: true
          },
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150
          },
          toolInvocations: [
            {
              id: '50000000-0000-4000-8000-000000000001',
              toolId: 'file-reader',
              displayName: 'File Reader',
              status: 'completed',
              inputSummary: 'E:\\OllamaDesktop\\README.md',
              outputSummary: 'Project summary',
              outputText: '### File Reader\n\nDetailed project summary',
              errorMessage: null,
              createdAt: '2026-04-08T00:00:00.000Z',
              updatedAt: '2026-04-08T00:00:00.000Z'
            }
          ],
          contextSources: [
            {
              id: '60000000-0000-4000-8000-000000000001',
              kind: 'document_chunk',
              label: 'README.md',
              excerpt: 'Ollama Desktop is a local-first desktop app.',
              sourcePath: 'E:\\OllamaDesktop\\README.md',
              documentId: null,
              score: 0.2
            }
          ],
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
      />
    );

    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('1 source')).toBeInTheDocument();
    expect(screen.getByText('File Reader')).toBeInTheDocument();
    expect(screen.queryByText('Detailed project summary')).not.toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    expect(screen.getByText(/Tokens: 120 in \/ 30 out/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand File Reader output' }));

    expect(screen.getByText('Detailed project summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Sources' }));

    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('shows live tool progress while an assistant turn is still streaming', () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000102',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'assistant',
          content: '',
          attachments: [],
          status: 'streaming',
          model: 'qwen2.5-coder:latest',
          correlationId: null,
          toolInvocations: [
            {
              id: '50000000-0000-4000-8000-000000000002',
              toolId: 'read',
              displayName: 'Read',
              status: 'completed',
              inputSummary: 'E:\\Test\\index.html',
              outputSummary: '<form id="login"></form>',
              errorMessage: null,
              createdAt: '2026-04-08T00:00:00.000Z',
              updatedAt: '2026-04-08T00:00:00.000Z'
            }
          ],
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
      />
    );

    expect(screen.getByText('Working through 1 tool step...')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
  });
});
