// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@renderer/App';
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
  title: 'Hello from test',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const userMessage = {
  id: '10000000-0000-4000-8000-000000000001',
  conversationId: conversation.id,
  role: 'user' as const,
  content: 'Hello from test',
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
  content: 'Original answer',
  attachments: [],
  status: 'completed' as const,
  model: 'llama3.2:latest',
  correlationId: '40000000-0000-4000-8000-000000000001',
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const streamingAssistantMessage = {
  ...assistantMessage,
  id: '10000000-0000-4000-8000-000000000003',
  content: '',
  status: 'streaming' as const
};

const attachment = {
  id: '70000000-0000-4000-8000-000000000001',
  fileName: 'notes.md',
  filePath: 'E:/docs/notes.md',
  mimeType: 'text/markdown',
  sizeBytes: 128,
  extractedText: '# Notes',
  createdAt: '2026-04-08T00:00:00.000Z'
};

const imageAttachment = {
  id: '70000000-0000-4000-8000-000000000002',
  fileName: 'reference.png',
  filePath: 'E:/images/reference.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  extractedText: null,
  createdAt: '2026-04-08T00:00:00.000Z'
};

const generationJob = {
  id: '80000000-0000-4000-8000-000000000001',
  workspaceId: workspace.id,
  conversationId: conversation.id,
  kind: 'image' as const,
  mode: 'image-to-image' as const,
  workflowProfile: 'qwen-image-edit-2511' as const,
  status: 'running' as const,
  prompt: 'Blend these references',
  negativePrompt: 'blur',
  model: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
  backend: 'comfyui' as const,
  width: 1664,
  height: 1248,
  steps: 4,
  guidanceScale: 1,
  seed: 7,
  progress: 0.1,
  stage: 'Loading image model',
  errorMessage: null,
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z',
  startedAt: '2026-04-08T00:00:00.000Z',
  completedAt: null,
  referenceImages: [imageAttachment],
  artifacts: []
};

const baseSettings = {
  textInferenceBackend: 'ollama' as const,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nvidiaApiKey: '',
  defaultModel: 'llama3.2:latest',
  codingModel: 'qwen2.5-coder:latest',
  visionModel: 'qwen3-vl:8b',
  imageGenerationModel: 'builtin:placeholder',
  additionalModelsDirectory: null,
  videoGenerationModel: '',
  pythonPort: 8765,
  theme: 'system' as const
};

const baseSystemStatus = {
  appVersion: '0.1.0',
  database: {
    ready: true,
    path: 'E:/tmp/ollama-desktop.sqlite'
  },
  activeTextBackend: 'ollama' as const,
  ollama: {
    reachable: true,
    baseUrl: 'http://127.0.0.1:11434',
    checkedAt: '2026-04-08T00:00:00.000Z',
    error: null,
    models: [
      { name: 'llama3.2:latest', size: null, digest: null },
      { name: 'qwen2.5-coder:latest', size: null, digest: null },
      { name: 'qwen3-vl:8b', size: null, digest: null }
    ]
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
};

const mockApi = {
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
    getAttachmentPreview: vi.fn(),
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
    listPermissions: vi.fn(),
    grantPermission: vi.fn(),
    revokePermission: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    listSchedules: vi.fn(),
    listAgents: vi.fn(),
    listTeams: vi.fn(),
    listWorktrees: vi.fn(),
    getPlanState: vi.fn(),
    listAuditEvents: vi.fn()
  }
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}

async function chooseComboboxOption(label: string, optionName: string | RegExp) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      initialized: false,
      bootstrapError: null,
      settings: null,
      systemStatus: null,
      workspaces: [],
      conversations: [],
      generationJobs: [],
      imageGenerationModelCatalog: null,
      availableTools: [],
      availableSkills: [],
      knowledgeDocumentsByWorkspace: {},
      searchQuery: '',
      searchResults: [],
      activeWorkspaceId: null,
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

    mockApi.settings.get.mockResolvedValue(baseSettings);
    mockApi.system.getStatus.mockResolvedValue(baseSystemStatus);
    mockApi.chat.listWorkspaces.mockResolvedValue([workspace]);
    mockApi.chat.listConversations.mockResolvedValue([]);
    mockApi.generation.listImageModels.mockResolvedValue({
      additionalModelsDirectory: null,
      options: [
        {
          id: 'builtin:placeholder',
          label: 'Built-in placeholder',
          description: 'Instant local placeholder image for queue, UI, and pipeline testing.',
          backend: 'placeholder',
          source: 'builtin',
          loadStrategy: 'placeholder',
          family: 'placeholder',
          supported: true,
          supportReason: null,
          baseModelId: null,
          path: null
        },
        {
          id: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
          label: 'Qwen-Image-Edit-2511-Q8_0.gguf',
          description: 'Local GGUF Qwen Image Edit checkpoint.',
          backend: 'comfyui',
          source: 'local-gguf',
          loadStrategy: 'comfyui-workflow',
          family: 'qwen-image-edit',
          supported: true,
          supportReason: null,
          baseModelId: null,
          path: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf'
        }
      ],
      warnings: []
    });
    mockApi.generation.listJobs.mockResolvedValue([]);
    mockApi.generation.startImage.mockResolvedValue({ job: generationJob, conversation: undefined });
    mockApi.chat.listTools.mockResolvedValue([
      {
        id: 'calculator',
        title: 'Calculator',
        description: 'Evaluate arithmetic expressions safely.',
        command: '/calc'
      }
    ]);
    mockApi.chat.listSkills.mockResolvedValue([
      {
        id: 'grounded',
        title: 'Grounded',
        description: 'Prefer workspace knowledge when answering.',
        prompt: 'Use workspace knowledge first.',
        source: 'builtin'
      }
    ]);
    mockApi.chat.listKnowledgeDocuments.mockResolvedValue([]);
    mockApi.chat.importWorkspaceKnowledge.mockResolvedValue({
      workspaceId: workspace.id,
      documents: [],
      skippedFiles: []
    });
    mockApi.chat.pickWorkspaceDirectory.mockResolvedValue({
      path: 'E:/Projects/demo-app'
    });
    mockApi.chat.updateWorkspaceRoot.mockResolvedValue({
      ...workspace,
      rootPath: 'E:/Projects/demo-app'
    });
    mockApi.chat.searchConversations.mockResolvedValue([]);
    mockApi.chat.getConversationMessages.mockResolvedValue([]);
    mockApi.chat.pickAttachments.mockResolvedValue([]);
    mockApi.chat.getAttachmentPreview.mockResolvedValue({
      dataUrl: 'data:image/png;base64,ZmFrZQ==',
      mimeType: 'image/png'
    });
    mockApi.chat.onStreamEvent.mockReturnValue(() => undefined);
    mockApi.generation.onJobEvent.mockReturnValue(() => undefined);
    mockApi.capabilities.listPermissions.mockResolvedValue([]);
    mockApi.capabilities.listTasks.mockResolvedValue([]);
    mockApi.capabilities.getTask.mockResolvedValue(null);
    mockApi.capabilities.listSchedules.mockResolvedValue([]);
    mockApi.capabilities.listAgents.mockResolvedValue([]);
    mockApi.capabilities.listTeams.mockResolvedValue([]);
    mockApi.capabilities.listWorktrees.mockResolvedValue([]);
    mockApi.capabilities.getPlanState.mockResolvedValue({
      conversationId: null,
      status: 'inactive',
      summary: null,
      createdAt: null,
      updatedAt: null
    });
    mockApi.capabilities.listAuditEvents.mockResolvedValue([]);
    mockApi.chat.importConversation.mockResolvedValue({
      path: 'E:/Exports/general.md',
      conversation: {
        ...conversation,
        title: 'Imported conversation'
      },
      workspace
    });
    mockApi.chat.exportConversation.mockResolvedValue({
      path: 'E:/Exports/general.md'
    });
    mockApi.settings.pickAdditionalModelsDirectory.mockResolvedValue({
      path: 'E:/ComfyUI/models'
    });
    mockApi.chat.start.mockResolvedValue({
      kind: 'chat',
      requestId: '30000000-0000-4000-8000-000000000001',
      model: 'llama3.2:latest',
      conversation,
      userMessage,
      assistantMessage: streamingAssistantMessage
    });
    mockApi.chat.editAndResend.mockResolvedValue({
      requestId: '30000000-0000-4000-8000-000000000002',
      model: 'llama3.2:latest',
      conversation,
      userMessage: {
        ...userMessage,
        content: 'Edited prompt'
      },
      assistantMessage: streamingAssistantMessage
    });
    mockApi.chat.regenerateResponse.mockResolvedValue({
      requestId: '30000000-0000-4000-8000-000000000003',
      model: 'llama3.2:latest',
      conversation,
      userMessage,
      assistantMessage: streamingAssistantMessage
    });

    window.ollamaDesktop = mockApi as unknown as typeof window.ollamaDesktop;
  });

  it('sends prompts through the preload bridge when Enter is pressed', async () => {
    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');

    fireEvent.change(textarea, {
      target: { value: 'Hello from test' }
    });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Hello from test',
        attachments: [],
        model: undefined
      });
    });
  });

  it('keeps a single Settings entrypoint in the main chat surface', async () => {
    render(<App />);

    expect(await screen.findAllByRole('button', { name: 'Settings' })).toHaveLength(1);
  });

  it('does not render the legacy All workspace filter', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: '+ Workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
  });

  it('does not duplicate the active chat heading inside the transcript', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);

    render(<App />);

    await screen.findByText('Original answer');

    expect(screen.getAllByText(conversation.title).length).toBeGreaterThanOrEqual(1);
  });

  it('polls system status while keeping the footer runtime pills minimal', async () => {
    const updatedStatus = {
      ...baseSystemStatus,
      ollama: {
        ...baseSystemStatus.ollama,
        checkedAt: '2026-04-08T00:00:03.000Z'
      },
      nvidia: {
        ...baseSystemStatus.nvidia,
        checkedAt: '2026-04-08T00:00:03.000Z'
      },
      python: {
        ...baseSystemStatus.python,
        checkedAt: '2026-04-08T00:00:03.000Z',
        modelManager: {
          ...baseSystemStatus.python.modelManager,
          device: 'cuda:0'
        },
        vram: {
          device: 'cuda:0',
          cudaAvailable: true,
          totalMb: 16384,
          freeMb: 14336,
          reservedMb: 1024,
          allocatedMb: 768
        }
      }
    };
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          intervalCallbacks.push(handler as () => void);
        }

        return 1 as unknown as number;
      }) as typeof window.setInterval);
    const clearIntervalSpy = vi
      .spyOn(window, 'clearInterval')
      .mockImplementation(() => undefined);

    try {
      render(<App />);

      await waitFor(() => {
        expect(mockApi.system.getStatus).toHaveBeenCalledTimes(1);
      });
      expect(intervalCallbacks.length).toBeGreaterThan(0);

      mockApi.system.getStatus.mockResolvedValue(updatedStatus);

      await act(async () => {
        await useAppStore.getState().refreshSystemStatus();
      });

      await waitFor(() => {
        expect(mockApi.system.getStatus).toHaveBeenCalledTimes(2);
      });
      expect(screen.getByText('3 model(s)')).toBeInTheDocument();
      expect(screen.queryByText('Python')).not.toBeInTheDocument();
      expect(screen.queryByText('VRAM')).not.toBeInTheDocument();
      expect(screen.queryByText(/MiB/)).not.toBeInTheDocument();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('shows immediate processing feedback and ignores duplicate sends while routing starts', async () => {
    const deferredStart = createDeferred<{
      kind: 'chat';
      requestId: string;
      model: string;
      conversation: typeof conversation;
      userMessage: typeof userMessage;
      assistantMessage: typeof streamingAssistantMessage;
    }>();
    mockApi.chat.start.mockImplementation(() => deferredStart.promise);

    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');
    fireEvent.change(textarea, {
      target: { value: 'Figure out which specialist should handle this.' }
    });
    const sendButton = screen.getByRole('button', { name: 'Send' });

    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    expect(await screen.findByText('Analyzing request')).toBeInTheDocument();
    expect(screen.getByText('The base model is classifying this request and selecting the best route.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyzing...' })).toBeDisabled();

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledTimes(1);
    });

    deferredStart.resolve({
      kind: 'chat',
      requestId: '30000000-0000-4000-8000-000000000099',
      model: 'llama3.2:latest',
      conversation,
      userMessage: {
        ...userMessage,
        content: 'Figure out which specialist should handle this.'
      },
      assistantMessage: streamingAssistantMessage
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });
  });

  it('renders an inline image job when normal chat submit auto-routes to generation', async () => {
    mockApi.chat.start.mockResolvedValue({
      kind: 'generation',
      requestId: '30000000-0000-4000-8000-000000000010',
      conversation,
      job: {
        ...generationJob,
        prompt: 'Now swap their clothing',
        status: 'queued',
        progress: 0,
        stage: 'Queued'
      },
      model: generationJob.model
    });

    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');

    fireEvent.change(textarea, {
      target: { value: 'Now swap their clothing' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Now swap their clothing',
        attachments: [],
        model: undefined
      });
    });

    await screen.findByText('Now swap their clothing');
    expect(screen.getByText('Image generation')).toBeInTheDocument();
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
  });

  it('does not submit on Shift+Enter', async () => {
    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');

    fireEvent.change(textarea, {
      target: { value: 'Hello from test' }
    });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });

    expect(mockApi.chat.start).not.toHaveBeenCalled();
  });

  it('attaches files and sends them with the prompt', async () => {
    mockApi.chat.pickAttachments.mockResolvedValue([attachment]);

    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Open add menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach files' }));

    await screen.findByText('notes.md');

    fireEvent.change(textarea, {
      target: { value: 'Please use the attachment' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Please use the attachment',
        attachments: [attachment],
        model: undefined
      });
    });
  });

  it('sends an explicit model override when the user switches out of Auto', async () => {
    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');

    await chooseComboboxOption('Model', 'qwen2.5-coder:latest');
    fireEvent.change(textarea, {
      target: { value: 'Build a login screen in HTML and CSS.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Build a login screen in HTML and CSS.',
        attachments: [],
        model: 'qwen2.5-coder:latest'
      });
    });
  });

  it('updates the selected text backend from the header selector', async () => {
    render(<App />);

    await chooseComboboxOption('Text backend', 'NVIDIA');

    await waitFor(() => {
      expect(mockApi.settings.update).toHaveBeenCalledWith({
        textInferenceBackend: 'nvidia'
      });
    });
  });

  it('sends an explicit think mode when the user selects one', async () => {
    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');

    await chooseComboboxOption('Think mode', 'Think medium');
    fireEvent.change(textarea, {
      target: { value: 'Review this codebase.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Review this codebase.',
        attachments: [],
        model: undefined,
        think: 'medium'
      });
    });
  });

  it('loads the last user message into edit mode and resends it', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);

    render(<App />);

    await screen.findByRole('button', { name: 'Edit & resend' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit & resend' }));

    const textarea = screen.getByLabelText('Message prompt');
    expect(textarea).toHaveValue('Hello from test');

    fireEvent.change(textarea, {
      target: { value: 'Edited prompt' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));

    await waitFor(() => {
      expect(mockApi.chat.editAndResend).toHaveBeenCalledWith({
        messageId: userMessage.id,
        prompt: 'Edited prompt',
        attachments: [],
        model: undefined
      });
    });
  });

  it('regenerates the last assistant response', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);

    render(<App />);

    await screen.findByRole('button', { name: 'Regenerate' });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => {
      expect(mockApi.chat.regenerateResponse).toHaveBeenCalledWith({
        assistantMessageId: assistantMessage.id,
        model: undefined
      });
    });
  });

  it('shows a stop button for in-flight replies and cancels the active assistant turn', async () => {
    render(<App />);

    const textarea = await screen.findByLabelText('Message prompt');
    fireEvent.change(textarea, {
      target: { value: 'Hello from test' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledTimes(1);
    });

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(mockApi.chat.cancelTurn).toHaveBeenCalledWith({
        assistantMessageId: streamingAssistantMessage.id
      });
    });
  });

  it('deletes the active conversation', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    await screen.findByRole('button', { name: 'Delete chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => {
      expect(mockApi.chat.deleteConversation).toHaveBeenCalledWith({
        conversationId: conversation.id
      });
    });
  });

  it('opens workspace actions on right click', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    fireEvent.contextMenu(await screen.findByRole('button', { name: workspace.name }));

    expect(screen.getByRole('menu', { name: 'Workspace actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open workspace' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Connect folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }));

    await waitFor(() => {
      expect(mockApi.chat.deleteWorkspace).toHaveBeenCalledWith({
        workspaceId: workspace.id
      });
    });
  });

  it('connects a folder to an existing workspace from the workspace context menu', async () => {
    mockApi.chat.updateWorkspaceRoot.mockResolvedValue({
      ...workspace,
      rootPath: 'E:/Projects/demo-app'
    });

    render(<App />);

    fireEvent.contextMenu(await screen.findByRole('button', { name: workspace.name }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect folder' }));

    await waitFor(() => {
      expect(mockApi.chat.pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
      expect(mockApi.chat.updateWorkspaceRoot).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        rootPath: 'E:/Projects/demo-app'
      });
    });
  });

  it('calls deleteConversation for a chat that has associated image jobs', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage]);
    mockApi.generation.listJobs.mockResolvedValue([generationJob]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    await screen.findByText('Blend these references');
    await screen.findByText('Loading image model');

    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => {
      expect(mockApi.chat.deleteConversation).toHaveBeenCalledWith({
        conversationId: conversation.id
      });
    });
  });

  it('opens chat actions on right click', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);

    render(<App />);

    fireEvent.contextMenu((await screen.findAllByText(conversation.title))[0]!);

    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open chat' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }));

    await waitFor(() => {
      expect(mockApi.chat.deleteConversation).toHaveBeenCalledWith({
        conversationId: conversation.id
      });
    });
  });

  it('creates a workspace only after a folder is selected', async () => {
    const newWorkspace = {
      ...workspace,
      id: '50000000-0000-4000-8000-000000000099',
      name: 'Frontend',
      rootPath: 'E:/Projects/demo-app'
    };

    mockApi.chat.createWorkspace.mockResolvedValue(newWorkspace);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Workspace' }));
    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Frontend' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace folder' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Workspace folder' })).toHaveTextContent(
        'E:/Projects/demo-app'
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => {
      expect(mockApi.chat.pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
      expect(mockApi.chat.createWorkspace).toHaveBeenCalledWith({
        name: 'Frontend',
        rootPath: 'E:/Projects/demo-app'
      });
    });
  });

  it('does not expose folder rebinding actions from the workspace menu', async () => {
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open workspace settings'
      })
    );

    expect(screen.getByRole('menuitem', { name: 'Add docs' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('starts a fresh conversation inside a newly created workspace', async () => {
    const newWorkspace = {
      ...workspace,
      id: '50000000-0000-4000-8000-000000000099',
      name: 'Frontend',
      rootPath: 'E:/Projects/demo-app'
    };

    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage, assistantMessage]);
    mockApi.chat.createWorkspace.mockResolvedValue(newWorkspace);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Workspace' }));
    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Frontend' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace folder' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Workspace folder' })).toHaveTextContent(
        'E:/Projects/demo-app'
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => {
      expect(mockApi.chat.createWorkspace).toHaveBeenCalledWith({
        name: 'Frontend',
        rootPath: 'E:/Projects/demo-app'
      });
    });

    const textarea = screen.getByLabelText('Message prompt');
    fireEvent.change(textarea, {
      target: { value: 'Scaffold the app shell' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: newWorkspace.id,
        prompt: 'Scaffold the app shell',
        attachments: [],
        model: undefined
      });
    });
  });

  it('imports workspace knowledge from the workspace settings menu', async () => {
    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open workspace settings'
      })
    );
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Add docs'
      })
    );

    await waitFor(() => {
      expect(mockApi.chat.importWorkspaceKnowledge).toHaveBeenCalledWith({
        workspaceId: workspace.id
      });
    });
  });

  it('keeps attachments in image mode and sends them as Qwen reference images', async () => {
    mockApi.settings.get.mockResolvedValue({
      ...baseSettings,
      imageGenerationModel: 'E:/ComfyUI/models/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
      additionalModelsDirectory: 'E:/ComfyUI/models'
    });
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([]);
    mockApi.chat.pickAttachments.mockResolvedValue([imageAttachment]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open add menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach files' }));
    await screen.findByText('reference.png');

    fireEvent.click(screen.getByRole('button', { name: 'Open add menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Generate image' }));

    const textarea = screen.getByLabelText('Message prompt');
    fireEvent.change(textarea, {
      target: { value: 'Blend these references' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => {
      expect(mockApi.generation.startImage).toHaveBeenCalledWith({
        conversationId: conversation.id,
        workspaceId: undefined,
        prompt: 'Blend these references',
        mode: 'image-to-image',
        workflowProfile: 'qwen-image-edit-2511',
        referenceImages: [imageAttachment]
      });
    });
  });

  it('returns to chat mode before sending attached-image analysis prompts', async () => {
    mockApi.chat.pickAttachments.mockResolvedValue([imageAttachment]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open add menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Generate image' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to chat' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open add menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach files' }));
    await screen.findByText('reference.png');

    const textarea = screen.getByLabelText('Message prompt');
    fireEvent.change(textarea, {
      target: { value: 'Describe this image' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockApi.chat.start).toHaveBeenCalledWith({
        conversationId: undefined,
        workspaceId: workspace.id,
        prompt: 'Describe this image',
        attachments: [imageAttachment],
        model: undefined
      });
    });

    expect(mockApi.generation.startImage).not.toHaveBeenCalled();
  });

  it('renders conversation-scoped image jobs directly in the chat timeline', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage]);
    mockApi.generation.listJobs.mockResolvedValue([generationJob]);

    render(<App />);

    await screen.findByText('Blend these references');
    expect(screen.getByText('Image generation')).toBeInTheDocument();
    expect(screen.getByText('Loading image model')).toBeInTheDocument();
  });

  it('retries failed image jobs from the shared queue drawer', async () => {
    mockApi.chat.listConversations.mockResolvedValue([conversation]);
    mockApi.chat.getConversationMessages.mockResolvedValue([userMessage]);
    mockApi.generation.listJobs.mockResolvedValue([
      {
        ...generationJob,
        id: '80000000-0000-4000-8000-000000000020',
        status: 'failed',
        stage: 'Failed',
        errorMessage: 'Worker offline'
      }
    ]);
    mockApi.generation.retryJob.mockResolvedValue({
      ...generationJob,
      id: '80000000-0000-4000-8000-000000000021',
      status: 'queued',
      stage: 'Queued',
      errorMessage: null
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Queue' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Retry job' }))[0]!);

    await waitFor(() => {
      expect(mockApi.generation.retryJob).toHaveBeenCalledWith({
        jobId: '80000000-0000-4000-8000-000000000020'
      });
    });
  });
});
