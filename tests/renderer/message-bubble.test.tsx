// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@renderer/components/message-bubble';

describe('MessageBubble', () => {
  beforeEach(() => {
    window.ollamaDesktop = {
      window: {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false)
      },
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
        startVideo: vi.fn(),
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
        deleteWorkspace: vi.fn(),
        listConversations: vi.fn(),
        searchConversations: vi.fn(),
        getConversationMessages: vi.fn(),
        getMessage: vi.fn().mockResolvedValue(null),
        listTools: vi.fn(),
        listSkills: vi.fn(),
        createSkill: vi.fn(),
        updateSkill: vi.fn(),
        deleteSkill: vi.fn(),
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
        deleteTask: vi.fn(),
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
    expect(screen.getByRole('button', { name: 'Expand thinking' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Answer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand thinking' }));

    expect(screen.getByRole('button', { name: 'Collapse thinking' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Reasoning details')).toBeInTheDocument();
    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('hides stray think tags from the visible answer text', () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000199',
          conversationId: '20000000-0000-4000-8000-000000000199',
          role: 'assistant',
          content: '/workspace-lister </think>\n\nNeed another pass.',
          attachments: [],
          status: 'completed',
          model: 'qwen3.6:35b-a3b-q4_K_M',
          correlationId: null,
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z'
        }}
      />
    );

    expect(screen.getByText('/workspace-lister')).toBeInTheDocument();
    expect(screen.getByText('Need another pass.')).toBeInTheDocument();
    expect(screen.queryByText('</think>')).not.toBeInTheDocument();
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
    expect(screen.getByText('1 tool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Sources' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/Tokens: 120 in \/ 30 out/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Tools' }));

    expect(screen.getAllByText('File Reader').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Expand File Reader output' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Expand File Reader output' }));

    expect(screen.getByText('Detailed project summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Sources' }));

    expect(screen.getByRole('button', { name: 'Collapse Sources' })).toHaveAttribute('aria-expanded', 'true');
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

    fireEvent.click(screen.getByRole('button', { name: 'Expand Tools' }));

    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  it('loads heavy message artifacts on demand when tool details are not hydrated yet', () => {
    const onLoadArtifacts = vi.fn();

    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000103',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'assistant',
          content: 'Answer kept light until details are opened.',
          attachments: [],
          status: 'completed',
          model: 'qwen2.5-coder:latest',
          correlationId: null,
          toolInvocationCount: 51,
          contextSourceCount: 12,
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
        onLoadArtifacts={onLoadArtifacts}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand Tools' }));
    expect(screen.getByText('Loading tool details from local storage...')).toBeInTheDocument();
    expect(onLoadArtifacts).toHaveBeenCalledWith('10000000-0000-4000-8000-000000000103');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Sources' }));
    expect(screen.getByText('Loading source details from local storage...')).toBeInTheDocument();
    expect(onLoadArtifacts).toHaveBeenCalledWith('10000000-0000-4000-8000-000000000103');
  });

  it('opens right-click message actions for editable messages', () => {
    const onEdit = vi.fn();
    const onTogglePin = vi.fn();

    render(
      <MessageBubble
        canEdit
        canPin
        message={{
          id: '10000000-0000-4000-8000-000000000110',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'user',
          content: 'Hello from test',
          attachments: [],
          status: 'completed',
          model: 'llama3.2:latest',
          correlationId: null,
          pinned: false,
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
        onEdit={onEdit}
        onTogglePin={onTogglePin}
      />
    );

    fireEvent.contextMenu(screen.getByText('Hello from test'));

    expect(screen.getByText('Hello from test').closest('article')).toHaveClass(
      'user-message-bubble'
    );
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit & resend' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit & resend' }));

    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '10000000-0000-4000-8000-000000000110'
      })
    );
  });

  it('paginates large tool and source lists after expansion', () => {
    render(
      <MessageBubble
        message={{
          id: '10000000-0000-4000-8000-000000000104',
          conversationId: '20000000-0000-4000-8000-000000000099',
          role: 'assistant',
          content: 'Large tool run.',
          attachments: [],
          status: 'completed',
          model: 'qwen2.5-coder:latest',
          correlationId: null,
          toolInvocations: Array.from({ length: 30 }, (_, index) => ({
            id: `50000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
            toolId: `tool-${index}`,
            displayName: `Tool ${index + 1}`,
            status: 'completed' as const,
            inputSummary: `input-${index + 1}`,
            outputSummary: `output-${index + 1}`,
            errorMessage: null,
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z'
          })),
          contextSources: Array.from({ length: 28 }, (_, index) => ({
            id: `60000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
            kind: 'document_chunk' as const,
            label: `Source ${index + 1}`,
            excerpt: `Excerpt ${index + 1}`,
            sourcePath: `E:\\Docs\\source-${index + 1}.md`,
            documentId: null,
            score: index / 100
          })),
          createdAt: '2026-04-08T00:00:00.000Z',
          updatedAt: '2026-04-08T00:00:00.000Z'
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand Tools' }));

    expect(screen.getByText('Tool 1')).toBeInTheDocument();
    expect(screen.getByText('Tool 25')).toBeInTheDocument();
    expect(screen.queryByText('Tool 30')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 5 more tools' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more tools' }));

    expect(screen.getByText('Tool 30')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Sources' }));

    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('Source 25')).toBeInTheDocument();
    expect(screen.queryByText('Source 28')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 3 more sources' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more sources' }));

    expect(screen.getByText('Source 28')).toBeInTheDocument();
  });
});
