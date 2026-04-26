// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '@bridge/ipc/contracts';
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

const alternateWorkspace = {
  id: '50000000-0000-4000-8000-000000000002',
  name: 'Workspace B',
  prompt: null,
  rootPath: 'E:/WorkspaceB',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const alternateConversation = {
  id: '20000000-0000-4000-8000-000000000002',
  workspaceId: alternateWorkspace.id,
  title: 'Workspace B chat',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const alternateUserMessage = {
  ...userMessage,
  id: '10000000-0000-4000-8000-000000000003',
  conversationId: alternateConversation.id
};

const alternateAssistantMessage = {
  ...assistantMessage,
  id: '10000000-0000-4000-8000-000000000004',
  conversationId: alternateConversation.id
};

describe('app-store stream buffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        startImage: vi.fn().mockResolvedValue({ job: undefined, conversation: undefined }),
        startVideo: vi.fn().mockResolvedValue({ job: undefined, conversation: undefined }),
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
        listGallery: vi.fn().mockResolvedValue([]),
        cancelJob: vi.fn(),
        retryJob: vi.fn(),
        deleteArtifact: vi.fn(),
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
        confirmGenerationIntent: vi.fn(),
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
        getComposerDraft: vi.fn(async () => null),
        setComposerDraft: vi.fn(async () => undefined),
        clearComposerDraft: vi.fn(async () => undefined),
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
        videoGenerationHighNoiseModel: '',
        videoGenerationLowNoiseModel: '',
        pythonPort: 8765,
        streamingMascotEnabled: true,
        notificationsEnabled: true,
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
      generationGalleryItems: [],
      imageGenerationModelCatalog: null,
      availableTools: [],
      availableSkills: [],
      capabilityPermissions: [],
      capabilityTasks: [],
      capabilitySchedules: [],
      capabilityAgents: [],
      capabilityTeams: [],
      capabilityWorktrees: [],
      capabilityPlanState: null,
      capabilityAuditEvents: [],
      knowledgeDocumentsByWorkspace: {},
      searchQuery: '',
      searchResults: [],
      activeWorkspaceId: workspace.id,
      activeConversationId: null,
      messagesByConversation: {},
      pendingGenerationConfirmation: null,
      selectedModel: '',
      settingsDrawerOpen: false,
      queueDrawerOpen: false,
      galleryDrawerOpen: false,
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

  it('inserts follow-up assistant loop messages created mid-turn and keeps the active stream on the newest message', async () => {
    await useAppStore.getState().sendPrompt('Hello');

    const followUpAssistantMessage = {
      ...assistantMessage,
      id: '10000000-0000-4000-8000-000000000099',
      content:
        '<think>\nChecking the workspace before the next step.\n</think>\n\nInspecting the current files.',
      status: 'streaming' as const,
      createdAt: '2026-04-08T00:00:02.000Z',
      updatedAt: '2026-04-08T00:00:02.000Z'
    };

    useAppStore.getState().applyStreamEvent({
      type: 'update',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: 'Initial loop reply',
      status: 'completed'
    });
    useAppStore.getState().applyStreamEvent({
      type: 'message-created',
      requestId: '30000000-0000-4000-8000-000000000001',
      conversationId: conversation.id,
      assistantMessageId: followUpAssistantMessage.id,
      message: followUpAssistantMessage
    });

    const state = useAppStore.getState();
    const assistantMessages =
      state.messagesByConversation[conversation.id]?.filter(
        (message) => message.role === 'assistant'
      ) ?? [];

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[1]?.id).toBe(followUpAssistantMessage.id);
    expect(assistantMessages[1]?.content).toContain('Inspecting the current files.');
    expect(state.streamingAssistantIds).not.toContain(assistantMessage.id);
    expect(state.streamingAssistantIds).toContain(followUpAssistantMessage.id);
  });

  it('applies capability snapshots from stream events immediately', async () => {
    await useAppStore.getState().sendPrompt('Hello');

    useAppStore.getState().applyStreamEvent({
      type: 'update',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: '',
      status: 'streaming',
      toolInvocations: [
        {
          id: '50000000-0000-4000-8000-000000000020',
          toolId: 'task-create',
          displayName: 'Task Create',
          status: 'completed',
          inputSummary: 'Inspect routing flow',
          outputSummary: 'task-id',
          errorMessage: null,
          createdAt: '2026-04-08T00:00:01.000Z',
          updatedAt: '2026-04-08T00:00:01.000Z'
        }
      ],
      capabilityPlanState: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        status: 'active',
        summary: 'Plan mode enabled.',
        createdAt: '2026-04-08T00:00:00.000Z',
        updatedAt: '2026-04-08T00:00:01.000Z'
      },
      capabilityTasks: [
        {
          id: '70000000-0000-4000-8000-000000000001',
          sequence: 1,
          workspaceId: workspace.id,
          title: 'Inspect routing flow',
          status: 'pending',
          details: null,
          outputPath: null,
          parentTaskId: null,
          createdAt: '2026-04-08T00:00:01.000Z',
          updatedAt: '2026-04-08T00:00:01.000Z',
          startedAt: null,
          completedAt: null
        }
      ]
    });

    const state = useAppStore.getState();

    expect(state.capabilityPlanState?.status).toBe('active');
    expect(state.capabilityTasks).toHaveLength(1);
    expect(state.capabilityTasks[0]?.title).toBe('Inspect routing flow');
    expect(window.ollamaDesktop.capabilities.listTasks).not.toHaveBeenCalled();
  });

  it('tracks lightweight metadata counts without hydrating the full tool and source payloads', async () => {
    await useAppStore.getState().sendPrompt('Hello');

    useAppStore.getState().applyStreamEvent({
      type: 'update',
      requestId: '30000000-0000-4000-8000-000000000001',
      assistantMessageId: assistantMessage.id,
      content: 'Working...',
      status: 'streaming',
      model: 'qwen2.5-coder:latest',
      toolInvocationCount: 12,
      contextSourceCount: 7
    });

    const state = useAppStore.getState();
    const latestMessage = state.messagesByConversation[conversation.id]?.at(-1);

    expect(latestMessage?.content).toBe('Working...');
    expect(latestMessage?.toolInvocationCount).toBe(12);
    expect(latestMessage?.contextSourceCount).toBe(7);
    expect(latestMessage?.toolInvocations).toBeUndefined();
    expect(latestMessage?.contextSources).toBeUndefined();
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

  it('stores pending generation confirmation when chat start detects a generation turn', async () => {
    window.ollamaDesktop.chat.start = vi.fn().mockResolvedValue({
      kind: 'generation-confirmation',
      requestId: '30000000-0000-4000-8000-000000000002',
      conversation,
      prompt: 'Now swap their clothing',
      attachments: [],
      detectedIntent: 'image',
      options: [
        {
          selection: 'image',
          label: 'Generate Image',
          description: 'Queue this prompt as a new image generation job.',
          recommended: true
        },
        {
          selection: 'chat',
          label: 'Continue Chat',
          description: 'Keep this request in the normal text chat flow.',
          recommended: false
        }
      ]
    });

    const resultKind = await useAppStore.getState().sendPrompt('Now swap their clothing');

    const state = useAppStore.getState();
    expect(resultKind).toBe('generation-confirmation');
    expect(state.activeConversationId).toBe(conversation.id);
    expect(state.conversations[0]?.id).toBe(conversation.id);
    expect(state.pendingGenerationConfirmation?.conversation.id).toBe(conversation.id);
    expect(state.pendingGenerationConfirmation?.options.map((option) => option.label)).toEqual([
      'Generate Image',
      'Continue Chat'
    ]);
    expect(state.messagesByConversation[conversation.id]).toEqual([]);
  });

  it('confirms a pending generation selection through the preload bridge', async () => {
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
      frameCount: null,
      frameRate: null,
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

    useAppStore.setState({
      pendingGenerationConfirmation: {
        kind: 'generation-confirmation',
        requestId: '30000000-0000-4000-8000-000000000002',
        conversation,
        prompt: 'Now swap their clothing',
        attachments: [],
        detectedIntent: 'image',
        options: [
          {
            selection: 'image',
            label: 'Generate Image',
            description: 'Queue this prompt as a new image generation job.',
            recommended: true
          },
          {
            selection: 'chat',
            label: 'Continue Chat',
            description: 'Keep this request in the normal text chat flow.',
            recommended: false
          }
        ]
      }
    });
    window.ollamaDesktop.chat.confirmGenerationIntent = vi.fn().mockResolvedValue({
      kind: 'generation',
      requestId: '30000000-0000-4000-8000-000000000003',
      conversation,
      job: generationJob,
      model: generationJob.model
    });

    const resultKind = await useAppStore.getState().confirmGenerationSelection('image');

    expect(resultKind).toBe('generation');
    expect(window.ollamaDesktop.chat.confirmGenerationIntent).toHaveBeenCalledWith({
      conversationId: conversation.id,
      prompt: 'Now swap their clothing',
      attachments: [],
      selection: 'image',
      model: undefined
    });
    expect(useAppStore.getState().pendingGenerationConfirmation).toBeNull();
    expect(useAppStore.getState().generationJobs[0]?.id).toBe(generationJob.id);
  });

  it('does not reuse the previous workspace conversation while the next workspace is still loading', async () => {
    const conversationMessagesDeferred: {
      resolve: (messages: StoredMessage[]) => void;
    } = {
      resolve: () => undefined
    };
    const pendingConversationMessages = new Promise<StoredMessage[]>((resolve) => {
      conversationMessagesDeferred.resolve = resolve;
    });

    window.ollamaDesktop.chat.getConversationMessages = vi.fn().mockImplementation((conversationId) => {
      if (conversationId === alternateConversation.id) {
        return pendingConversationMessages;
      }

      return Promise.resolve([]);
    });
    window.ollamaDesktop.chat.start = vi.fn().mockResolvedValue({
      kind: 'chat',
      requestId: '30000000-0000-4000-8000-000000000003',
      model: 'llama3.2:latest',
      conversation: alternateConversation,
      userMessage: alternateUserMessage,
      assistantMessage: alternateAssistantMessage
    });

    useAppStore.setState({
      workspaces: [workspace, alternateWorkspace],
      conversations: [conversation, alternateConversation],
      activeWorkspaceId: workspace.id,
      activeConversationId: conversation.id,
      messagesByConversation: {
        [conversation.id]: [userMessage, assistantMessage]
      }
    });

    const selectWorkspacePromise = useAppStore.getState().selectWorkspace(alternateWorkspace.id);

    expect(useAppStore.getState().activeWorkspaceId).toBe(alternateWorkspace.id);
    expect(useAppStore.getState().activeConversationId).toBe(alternateConversation.id);

    await useAppStore.getState().sendPrompt('Explain the latest status.');

    expect(window.ollamaDesktop.chat.start).toHaveBeenCalledWith({
      conversationId: alternateConversation.id,
      workspaceId: undefined,
      prompt: 'Explain the latest status.',
      attachments: [],
      model: undefined
    });

    conversationMessagesDeferred.resolve([]);
    await selectWorkspacePromise;
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
      frameCount: null,
      frameRate: null,
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

  it('deletes generation artifacts through the preload bridge and updates the job', async () => {
    const completedJob = {
      id: '80000000-0000-4000-8000-000000000012',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      kind: 'image' as const,
      mode: 'text-to-image' as const,
      workflowProfile: 'default' as const,
      status: 'completed' as const,
      prompt: 'A quiet gallery',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder' as const,
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      frameCount: null,
      frameRate: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: '2026-04-08T00:00:00.000Z',
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: [],
      artifacts: [
        {
          id: '81000000-0000-4000-8000-000000000001',
          jobId: '80000000-0000-4000-8000-000000000012',
          kind: 'image' as const,
          filePath: 'E:/generated/gallery.png',
          previewPath: null,
          mimeType: 'image/png',
          width: 768,
          height: 768,
          createdAt: '2026-04-08T00:00:00.000Z'
        }
      ]
    };
    const updatedJob = {
      ...completedJob,
      artifacts: []
    };
    const artifactId = completedJob.artifacts[0]?.id;

    window.ollamaDesktop.generation.deleteArtifact = vi.fn().mockResolvedValue(undefined);
    window.ollamaDesktop.generation.listJobs = vi.fn().mockResolvedValue([updatedJob]);
    window.ollamaDesktop.generation.listGallery = vi.fn().mockResolvedValue([]);
    useAppStore.setState({
      generationJobs: [completedJob],
      generationGalleryItems: [
        {
          id: artifactId ?? '',
          artifactId: artifactId ?? null,
          jobId: completedJob.id,
          kind: 'image',
          filePath: 'E:/generated/gallery.png',
          previewPath: null,
          mimeType: 'image/png',
          width: 768,
          height: 768,
          frameCount: null,
          frameRate: null,
          prompt: completedJob.prompt,
          model: completedJob.model,
          createdAt: '2026-04-08T00:00:00.000Z',
          completedAt: '2026-04-08T00:00:00.000Z'
        }
      ]
    });

    expect(artifactId).toBeDefined();
    await useAppStore.getState().deleteGenerationArtifact(artifactId ?? '');

    expect(window.ollamaDesktop.generation.deleteArtifact).toHaveBeenCalledWith({
      artifactId
    });
    expect(useAppStore.getState().generationJobs[0]?.artifacts).toEqual([]);
  });

  it('refreshes the gallery when opening the gallery drawer', async () => {
    const galleryItem = {
      id: 'file:gallery-image',
      artifactId: null,
      jobId: null,
      kind: 'image' as const,
      filePath: 'E:/generated/gallery.png',
      previewPath: null,
      mimeType: 'image/png',
      width: null,
      height: null,
      frameCount: null,
      frameRate: null,
      prompt: 'gallery.png',
      model: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      completedAt: '2026-04-08T00:00:00.000Z'
    };

    window.ollamaDesktop.generation.listGallery = vi.fn().mockResolvedValue([galleryItem]);

    useAppStore.getState().toggleGalleryDrawer(true);

    await vi.waitFor(() => {
      expect(window.ollamaDesktop.generation.listGallery).toHaveBeenCalled();
    });
    expect(useAppStore.getState().generationGalleryItems).toEqual([galleryItem]);
  });

  it('deletes filesystem gallery items by file path when no artifact row exists', async () => {
    const galleryItem = {
      id: 'file:gallery-image',
      artifactId: null,
      jobId: null,
      kind: 'image' as const,
      filePath: 'E:/generated/gallery.png',
      previewPath: 'E:/generated/gallery-preview.png',
      mimeType: 'image/png',
      width: null,
      height: null,
      frameCount: null,
      frameRate: null,
      prompt: 'gallery.png',
      model: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      completedAt: '2026-04-08T00:00:00.000Z'
    };

    window.ollamaDesktop.generation.deleteArtifact = vi.fn().mockResolvedValue(undefined);
    window.ollamaDesktop.generation.listJobs = vi.fn().mockResolvedValue([]);
    window.ollamaDesktop.generation.listGallery = vi.fn().mockResolvedValue([]);
    useAppStore.setState({
      generationGalleryItems: [galleryItem]
    });

    await useAppStore.getState().deleteGenerationArtifact(galleryItem.id);

    expect(window.ollamaDesktop.generation.deleteArtifact).toHaveBeenCalledWith({
      filePath: galleryItem.filePath
    });
    expect(useAppStore.getState().generationGalleryItems).toEqual([]);
  });
});
