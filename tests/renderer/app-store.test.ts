// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@renderer/store/app-store';

const workspace = {
  id: '50000000-0000-4000-8000-000000000001',
  name: 'General',
  prompt: null,
  rootPath: null,
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const conversation = {
  id: '20000000-0000-4000-8000-000000000001',
  workspaceId: workspace.id,
  title: 'Buffered reply test',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const userMessage = {
  id: '10000000-0000-4000-8000-000000000001',
  conversationId: conversation.id,
  role: 'user' as const,
  content: 'Hello',
  attachments: [],
  status: 'completed' as const,
  model: 'llama3.2:latest',
  correlationId: '40000000-0000-4000-8000-000000000001',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const assistantMessage = {
  id: '10000000-0000-4000-8000-000000000002',
  conversationId: conversation.id,
  role: 'assistant' as const,
  content: '',
  attachments: [],
  status: 'streaming' as const,
  model: 'llama3.2:latest',
  correlationId: '40000000-0000-4000-8000-000000000001',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

describe('app-store stream buffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        startImage: vi.fn().mockResolvedValue({ job: undefined, conversation: undefined }),
        listImageModels: vi.fn().mockResolvedValue({
          additionalModelsDirectory: null,
          options: [
            {
              id: 'builtin:placeholder',
              label: 'Built-in placeholder',
              description:
                'Instant local placeholder image for queue, UI, and pipeline testing.',
              backend: 'placeholder',
              source: 'builtin',
              loadStrategy: 'placeholder',
              family: 'placeholder',
              supported: true,
              supportReason: null,
              baseModelId: null,
              path: null
            }
          ],
          warnings: []
        }),
        listJobs: vi.fn().mockResolvedValue([]),
        cancelJob: vi.fn(),
        retryJob: vi.fn(),
        onJobEvent: vi.fn()
      },
      chat: {
        start: vi.fn().mockResolvedValue({
          kind: 'chat',
          requestId: '30000000-0000-4000-8000-000000000001',
          model: 'llama3.2:latest',
          conversation,
          userMessage,
          assistantMessage
        }),
        pickAttachments: vi.fn(),
        editAndResend: vi.fn(),
        regenerateResponse: vi.fn(),
        cancelTurn: vi.fn(),
        deleteConversation: vi.fn(),
        pinMessage: vi.fn(),
        getAttachmentPreview: vi.fn(),
        openLocalPath: vi.fn(),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(),
        pickWorkspaceDirectory: vi.fn(),
        updateWorkspaceRoot: vi.fn(),
        deleteWorkspace: vi.fn(),
        listConversations: vi.fn(),
        searchConversations: vi.fn(),
        getConversationMessages: vi.fn().mockResolvedValue([]),
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

    useAppStore.setState({
      initialized: true,
      bootstrapError: null,
      settings: {
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        textInferenceBackend: 'ollama',
        nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
        nvidiaApiKey: '',
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest',
        visionModel: 'qwen3-vl:8b',
        imageGenerationModel: 'builtin:placeholder',
        additionalModelsDirectory: null,
        videoGenerationModel: '',
        pythonPort: 8765,
        theme: 'system'
      },
      systemStatus: {
        appVersion: '0.1.0',
        database: {
          ready: true,
          path: 'E:/tmp/ollama-desktop.sqlite'
        },
        activeTextBackend: 'ollama',
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          checkedAt: '2026-04-08T00:00:00.000Z',
          error: null,
          models: [{ name: 'llama3.2:latest', size: null, digest: null }]
        },
        nvidia: {
          configured: false,
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          checkedAt: '2026-04-08T00:00:00.000Z',
          error: 'Add an NVIDIA API key in Settings to use this backend.',
          models: [{ name: 'meta/llama-3.1-8b-instruct', size: null, digest: null }]
        },
        python: {
          reachable: true,
          url: 'http://127.0.0.1:8765',
          checkedAt: '2026-04-08T00:00:00.000Z',
          pid: 1234,
          error: null,
          runtime: 'E:/OllamaDesktop/python_embeded/python.exe',
          modelManager: {
            loadedModel: null,
            loadedBackend: null,
            device: 'cpu',
            lastError: null
          },
          vram: {
            device: 'cpu',
            cudaAvailable: false,
            totalMb: null,
            freeMb: null,
            reservedMb: null,
            allocatedMb: null
          }
        },
        pendingRequestCount: 0
      },
      workspaces: [workspace],
      conversations: [],
      generationJobs: [],
      imageGenerationModelCatalog: null,
      availableTools: [],
      availableSkills: [],
      knowledgeDocumentsByWorkspace: {},
      searchQuery: '',
      searchResults: [],
      activeWorkspaceId: workspace.id,
      activeConversationId: null,
      messagesByConversation: {},
      selectedModel: '',
      settingsDrawerOpen: false,
      queueDrawerOpen: false,
      streamingAssistantIds: [],
      pendingStreamEventsByAssistantId: {},
      lastExportPath: null,
      lastImportPath: null
    });
  });

  it('hydrates a completed assistant reply when the stream event arrives before the placeholder is in state', async () => {
    useAppStore.getState().applyStreamEvent({
      type: 'complete',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: 'Visible reply',
      doneReason: 'stop'
    });

    await useAppStore.getState().sendPrompt('Hello');

    const state = useAppStore.getState();
    const latestMessage = state.messagesByConversation[conversation.id]?.at(-1);

    expect(latestMessage?.id).toBe(assistantMessage.id);
    expect(latestMessage?.content).toBe('Visible reply');
    expect(latestMessage?.status).toBe('completed');
    expect(state.pendingStreamEventsByAssistantId[assistantMessage.id]).toBeUndefined();
    expect(state.streamingAssistantIds).not.toContain(assistantMessage.id);
    expect(state.systemStatus?.pendingRequestCount).toBe(0);
  });

  it('rehydrates message metadata after a terminal stream event', async () => {
    window.ollamaDesktop.chat.getConversationMessages = vi.fn().mockResolvedValue([
      userMessage,
      {
        ...assistantMessage,
        content: 'Visible reply',
        status: 'completed',
        routeTrace: {
          strategy: 'rag-chat',
          reason: 'workspace-knowledge-routing',
          confidence: 0.88,
          selectedModel: 'llama3.2:latest',
          fallbackModel: null,
          activeSkillId: 'grounded',
          activeToolId: null,
          usedWorkspacePrompt: true,
          usedPinnedMessages: false,
          usedRag: true,
          usedTools: false
        },
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120
        }
      }
    ]);

    await useAppStore.getState().sendPrompt('Hello');
    useAppStore.getState().applyStreamEvent({
      type: 'complete',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: 'Visible reply',
      doneReason: 'stop'
    });

    await vi.waitFor(() => {
      const state = useAppStore.getState();
      const latestMessage = state.messagesByConversation[conversation.id]?.at(-1);

      expect(latestMessage?.routeTrace?.strategy).toBe('rag-chat');
      expect(latestMessage?.usage?.totalTokens).toBe(120);
    });
  });

  it('applies live assistant tool updates before the terminal event arrives', async () => {
    await useAppStore.getState().sendPrompt('Hello');

    useAppStore.getState().applyStreamEvent({
      type: 'update',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: '',
      status: 'streaming',
      model: 'qwen2.5-coder:latest',
      routeTrace: {
        strategy: 'skill-chat',
        reason: 'model-skill-routing',
        confidence: 0.9,
        selectedModel: 'qwen2.5-coder:latest',
        fallbackModel: 'llama3.2:latest',
        activeSkillId: 'builder',
        activeToolId: null,
        usedWorkspacePrompt: false,
        usedPinnedMessages: false,
        usedRag: false,
        usedTools: true
      },
      toolInvocations: [
        {
          id: '50000000-0000-4000-8000-000000000010',
          toolId: 'read',
          displayName: 'Read',
          status: 'completed',
          inputSummary: 'E:\\Test\\index.html',
          outputSummary: '<form id="login"></form>',
          errorMessage: null,
          createdAt: '2026-04-08T00:00:01.000Z',
          updatedAt: '2026-04-08T00:00:01.000Z'
        }
      ]
    });

    const state = useAppStore.getState();
    const latestMessage = state.messagesByConversation[conversation.id]?.at(-1);

    expect(latestMessage?.status).toBe('streaming');
    expect(latestMessage?.routeTrace?.activeSkillId).toBe('builder');
    expect(latestMessage?.toolInvocations?.[0]?.toolId).toBe('read');
    expect(latestMessage?.toolInvocations?.[0]?.status).toBe('completed');
    expect(state.systemStatus?.pendingRequestCount).toBe(1);
  });

  it('keeps new chats in auto model mode so routing can use configured roles', async () => {
    await useAppStore.getState().sendPrompt('Hello');

    expect(window.ollamaDesktop.chat.start).toHaveBeenCalledWith({
      conversationId: undefined,
      workspaceId: workspace.id,
      prompt: 'Hello',
      attachments: [],
      model: undefined
    });
  });

  it('activates the conversation and appends inline generation jobs when chat start auto-routes to image generation', async () => {
    const generationJob = {
      id: '80000000-0000-4000-8000-000000000001',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      kind: 'image' as const,
      mode: 'image-to-image' as const,
      workflowProfile: 'qwen-image-edit-2511' as const,
      status: 'queued' as const,
      prompt: 'Now swap their clothing',
      negativePrompt: null,
      model: 'E:/LocalModels/Qwen-Image-Edit-2511-Q8_0.gguf',
      backend: 'comfyui' as const,
      width: 1664,
      height: 1248,
      steps: 4,
      guidanceScale: 1,
      seed: null,
      progress: 0,
      stage: 'Queued',
      errorMessage: null,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      referenceImages: [],
      artifacts: []
    };

    window.ollamaDesktop.chat.start = vi.fn().mockResolvedValue({
      kind: 'generation',
      requestId: '30000000-0000-4000-8000-000000000002',
      conversation,
      job: generationJob,
      model: generationJob.model
    });

    await useAppStore.getState().sendPrompt('Now swap their clothing');

    const state = useAppStore.getState();
    expect(state.activeConversationId).toBe(conversation.id);
    expect(state.conversations[0]?.id).toBe(conversation.id);
    expect(state.generationJobs[0]?.id).toBe(generationJob.id);
    expect(state.messagesByConversation[conversation.id]).toEqual([]);
  });

  it('retries failed generation jobs through the preload bridge and prepends the new job', async () => {
    const failedJob = {
      id: '80000000-0000-4000-8000-000000000010',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      kind: 'image' as const,
      mode: 'text-to-image' as const,
      workflowProfile: 'default' as const,
      status: 'failed' as const,
      prompt: 'Retry this skyline',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder' as const,
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 0,
      stage: 'Failed',
      errorMessage: 'Worker offline',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: [],
      artifacts: []
    };
    const retriedJob = {
      ...failedJob,
      id: '80000000-0000-4000-8000-000000000011',
      status: 'queued' as const,
      stage: 'Queued',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:01.000Z',
      updatedAt: '2026-04-08T00:00:01.000Z',
      completedAt: null
    };

    window.ollamaDesktop.generation.retryJob = vi.fn().mockResolvedValue({ job: retriedJob, conversation: undefined });
    useAppStore.setState({
      generationJobs: [failedJob]
    });

    await useAppStore.getState().retryGenerationJob(failedJob.id);

    expect(window.ollamaDesktop.generation.retryJob).toHaveBeenCalledWith({
      jobId: failedJob.id
    });
    expect(useAppStore.getState().generationJobs[0]?.id).toBe(retriedJob.id);
  });
});
