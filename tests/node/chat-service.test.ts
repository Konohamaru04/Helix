import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { ChatService } from '@bridge/chat/service';
import { TurnMetadataService } from '@bridge/chat/turn-metadata';
import { CapabilityRepository, CapabilityService } from '@bridge/capabilities';
import { DatabaseManager } from '@bridge/db/database';
import { GenerationRepository } from '@bridge/generation/repository';
import type { GenerationService } from '@bridge/generation/service';
import type { ChatStreamEvent } from '@bridge/ipc/contracts';
import { createLogger } from '@bridge/logging/logger';
import { MemoryService } from '@bridge/memory';
import { BridgeQueue } from '@bridge/queue';
import { RagService } from '@bridge/rag';
import { ChatRouter } from '@bridge/router';
import { SettingsService } from '@bridge/settings/service';
import { SkillRegistry } from '@bridge/skills';
import { type WorkspacePathLauncher, ToolDispatcher } from '@bridge/tools';

const tempDirectories: string[] = [];

interface VisionStreamCall {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    images?: string[];
  }>;
}

function getMockMessages(
  value: unknown
): Array<{ role: string; content: string }> {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    return [];
  }

  const rawMessages = (value as { messages?: unknown }).messages;

  if (!Array.isArray(rawMessages)) {
    return [];
  }

  return rawMessages.flatMap((message) => {
    if (!message || typeof message !== 'object') {
      return [];
    }

    const candidate = message as Record<string, unknown>;
    const role = candidate.role;
    const content = candidate.content;

    return typeof role === 'string' && typeof content === 'string'
      ? [{ role, content }]
      : [];
  });
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createChatServiceHarness(options: {
  directory: string;
  loggerName: string;
  models?: string[];
  modelCatalog?: Array<{
    name: string;
    size: number | null;
    digest?: string | null;
  }>;
  streamChat?: ReturnType<typeof vi.fn>;
  completeChat?: ReturnType<typeof vi.fn>;
  nvidiaModels?: string[];
  nvidiaConfigured?: boolean;
  nvidiaStreamChat?: ReturnType<typeof vi.fn>;
  nvidiaCompleteChat?: ReturnType<typeof vi.fn>;
  openWorkspacePath?: WorkspacePathLauncher;
  generationService?: Partial<Pick<GenerationService, 'startImageJob' | 'startVideoJob'>>;
  readFreeMemoryBytes?: () => number;
}) {
  const logger = createLogger(options.loggerName);
  const database = new DatabaseManager(path.join(options.directory, 'ollama-desktop.sqlite'), logger);
  database.initialize();

  const settingsService = new SettingsService(database, logger);
  settingsService.ensureDefaults();
  const repository = new ChatRepository(database);
  repository.ensureDefaultWorkspace();
  const turnMetadataService = new TurnMetadataService(database);
  const ragService = new RagService(database, logger);
  const generationRepository = new GenerationRepository(database);
  const skillRegistry = new SkillRegistry(path.join('E:\\OllamaDesktop', 'skills'), database);
  skillRegistry.load();
  const memoryService = new MemoryService(repository, turnMetadataService);
  const queue = new BridgeQueue();
  const router = new ChatRouter(logger);
  const ollamaClient = {
    getStatus: vi.fn().mockResolvedValue({
      reachable: true,
      baseUrl: 'http://127.0.0.1:11434',
      checkedAt: '2026-04-08T00:00:00.000Z',
      error: null,
      models:
        options.modelCatalog ??
        (options.models ?? ['llama3.2:latest']).map((name) => ({
          name,
          size: null,
          digest: null
        }))
    }),
    streamChat: options.streamChat ?? vi.fn().mockResolvedValue({ doneReason: 'stop' }),
    completeChat:
      options.completeChat ??
      vi.fn().mockResolvedValue({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
  };
  const nvidiaClient = {
    getStatus: vi.fn().mockResolvedValue({
      configured: options.nvidiaConfigured ?? true,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      checkedAt: '2026-04-13T00:00:00.000Z',
      error:
        options.nvidiaConfigured === false
          ? 'Add an NVIDIA API key in Settings to use this backend.'
          : null,
      models: (options.nvidiaModels ?? ['meta/llama-3.1-8b-instruct']).map((name) => ({
        name,
        size: null,
        digest: null
      }))
    }),
    streamChat:
      options.nvidiaStreamChat ??
      vi.fn().mockResolvedValue({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      }),
    completeChat:
      options.nvidiaCompleteChat ??
      vi.fn().mockResolvedValue({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
  };
  const capabilityRepository = new CapabilityRepository(database);
  const capabilityService = new CapabilityService(
    options.directory,
    capabilityRepository,
    repository,
    skillRegistry,
    {
      get: () => settingsService.get()
    },
    ollamaClient as never,
    nvidiaClient as never,
    logger
  );
  const toolDispatcher = new ToolDispatcher(
    options.directory,
    repository,
    ragService,
    options.openWorkspacePath,
    undefined,
    capabilityService
  );
  const generationService =
    options.generationService === undefined
      ? undefined
      : ({
          startImageJob:
            options.generationService.startImageJob ??
            ((vi.fn(() =>
              Promise.reject(new Error('startImageJob was not mocked for this test.'))
            ) as unknown) as GenerationService['startImageJob']),
          startVideoJob:
            options.generationService.startVideoJob ??
            ((vi.fn(() =>
              Promise.reject(new Error('startVideoJob was not mocked for this test.'))
            ) as unknown) as GenerationService['startVideoJob'])
        } satisfies Pick<GenerationService, 'startImageJob' | 'startVideoJob'>);
  const service = new ChatService(
    repository,
    turnMetadataService,
    settingsService,
    ollamaClient as never,
    nvidiaClient as never,
    router,
    queue,
    logger,
    memoryService,
    ragService,
    toolDispatcher,
    skillRegistry,
    generationRepository,
    generationService,
    options.readFreeMemoryBytes
  );

  return {
    database,
    capabilityService,
    generationRepository,
    repository,
    service,
    settingsService,
    turnMetadataService,
    ollamaClient,
    nvidiaClient,
    toolDispatcher
  };
}

describe('ChatService', () => {
  it('round-trips markdown exports with attachments while stripping local file paths', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-service-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-service-test'
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Review my notes',
        workspaceId: workspace.id
      });

      harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Please review the attachment.',
        attachments: [
          {
            id: '90000000-0000-4000-8000-000000000001',
            fileName: 'notes.md',
            filePath: 'E:/private/notes.md',
            mimeType: 'text/markdown',
            sizeBytes: 128,
            extractedText: '# Notes',
            createdAt: '2026-04-08T00:00:00.000Z'
          }
        ],
        status: 'completed'
      });
      harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Reviewed.',
        attachments: [],
        status: 'completed'
      });

      const markdown = harness.service.exportConversation({
        conversationId: conversation.id,
        format: 'markdown'
      });

      expect(markdown).toContain('OLLAMA_DESKTOP_EXPORT:');
      expect(markdown).not.toContain('E:/private/notes.md');

      const exportPath = path.join(directory, 'conversation.md');
      writeFileSync(exportPath, markdown, 'utf8');

      const result = await harness.service.importConversationFromFile(exportPath);
      const importedMessages = harness.repository.listMessages(result.conversation.id);

      expect(importedMessages).toHaveLength(2);
      expect(importedMessages[0]?.attachments).toHaveLength(1);
      expect(importedMessages[0]?.attachments[0]?.fileName).toBe('notes.md');
      expect(importedMessages[0]?.attachments[0]?.filePath).toBeNull();
      expect(importedMessages[0]?.attachments[0]?.extractedText).toBe('# Notes');
    } finally {
      harness.database.close();
    }
  });

  it('returns lightweight UI messages with artifact counts while keeping full details in SQLite', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-ui-metadata-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-ui-metadata-test'
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Metadata count test',
        workspaceId: workspace.id
      });

      harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Inspect the settings flow.',
        status: 'completed'
      });

      const assistantMessage = harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Done.',
        status: 'completed'
      });

      harness.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: assistantMessage.id,
        routeTrace: {
          strategy: 'rag-tool',
          reason: 'workspace-knowledge-routing',
          confidence: 0.9,
          selectedModel: 'llama3.2:latest',
          fallbackModel: null,
          activeSkillId: 'builder',
          activeToolId: 'read',
          usedWorkspacePrompt: true,
          usedPinnedMessages: false,
          usedRag: true,
          usedTools: true
        },
        usage: {
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150
        },
        toolInvocations: [
          harness.turnMetadataService.createToolInvocation({
            toolId: 'read',
            displayName: 'Read',
            status: 'completed',
            inputSummary: 'E:/workspace/settings.ts',
            outputSummary: 'Loaded the settings file',
            outputText: '### Read\n\nsettings content',
            errorMessage: null
          })
        ],
        contextSources: [
          harness.turnMetadataService.createContextSource({
            kind: 'document_chunk',
            label: 'settings.md',
            excerpt: 'Settings are persisted locally.',
            sourcePath: 'E:/workspace/settings.md',
            documentId: null,
            score: 0.12
          })
        ]
      });

      const uiMessages = harness.service.listMessagesForUi(conversation.id);
      const lightweightAssistantMessage = uiMessages.at(-1);
      const hydratedAssistantMessage = harness.service.getMessage(assistantMessage.id);

      expect(lightweightAssistantMessage?.toolInvocationCount).toBe(1);
      expect(lightweightAssistantMessage?.contextSourceCount).toBe(1);
      expect(lightweightAssistantMessage?.toolInvocations).toBeUndefined();
      expect(lightweightAssistantMessage?.contextSources).toBeUndefined();
      expect(hydratedAssistantMessage?.toolInvocations).toHaveLength(1);
      expect(hydratedAssistantMessage?.contextSources).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });

  it('sends image attachments to Ollama as multimodal images', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-vision-'));
    tempDirectories.push(directory);

    let capturedInput: VisionStreamCall | undefined;
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        capturedInput = {
          model: input.model,
          messages: input.messages
        };

        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-vision-test',
      models: ['qwen3-vl:8b'],
      streamChat
    });

    try {
      const imagePath = path.join(directory, 'face.webp');
      const imageBytes = Buffer.from([1, 2, 3, 4]);
      writeFileSync(imagePath, imageBytes);

      const attachments = await harness.service.prepareAttachments([imagePath]);
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Who is in this image?',
          model: 'qwen3-vl:8b',
          attachments
        },
        () => undefined
      );

      await vi.waitFor(() => {
        expect(capturedInput).toBeDefined();
      });
      await vi.waitFor(() => {
        const latestMessages = harness.repository.listMessages(accepted.conversation.id);
        expect(latestMessages.at(-1)?.status).toBe('completed');
      });

      expect(streamChat).toHaveBeenCalledTimes(1);

      if (!capturedInput) {
        throw new Error('Expected the multimodal Ollama input to be captured.');
      }

      const userMessage = capturedInput.messages.find((message) => message.role === 'user');
      expect(capturedInput.model).toBe('qwen3-vl:8b');
      expect(userMessage?.content).toContain('Who is in this image?');
      expect(userMessage?.images).toEqual([imageBytes.toString('base64')]);
    } finally {
      harness.database.close();
    }
  });

  it('omits prior image bytes when a follow-up turn uses a non-vision model', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-vision-follow-up-'));
    tempDirectories.push(directory);

    const capturedInputs: VisionStreamCall[] = [];
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        capturedInputs.push({
          model: input.model,
          messages: input.messages
        });
        input.onDelta(input.model.includes('vl') ? 'Vision reply.' : 'Text reply.');

        return Promise.resolve({
          content: input.model.includes('vl') ? 'Vision reply.' : 'Text reply.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-vision-follow-up-test',
      models: ['qwen3-vl:8b', 'llama3.2:latest'],
      streamChat
    });

    try {
      const imagePath = path.join(directory, 'scene.png');
      writeFileSync(imagePath, Buffer.from([5, 6, 7, 8]));

      const attachments = await harness.service.prepareAttachments([imagePath]);
      const firstAccepted = await harness.service.startChatTurn(
        {
          prompt: 'Describe this image.',
          model: 'qwen3-vl:8b',
          attachments
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const latestMessages = harness.repository.listMessages(firstAccepted.conversation.id);
        expect(latestMessages.at(-1)?.status).toBe('completed');
      });

      await harness.service.startChatTurn(
        {
          conversationId: firstAccepted.conversation.id,
          prompt: 'Summarize your previous answer in one sentence.',
          model: 'llama3.2:latest'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        expect(capturedInputs).toHaveLength(2);
      });

      const followUpInput = capturedInputs[1];

      expect(followUpInput?.model).toBe('llama3.2:latest');
      expect(
        followUpInput?.messages.flatMap((message) => message.images ?? [])
      ).toEqual([]);
      expect(
        followUpInput?.messages.some((message) => message.content.includes('Attached image'))
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it('routes standard chat turns through NVIDIA when the NVIDIA backend is selected', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-nvidia-'));
    tempDirectories.push(directory);

    const nvidiaStreamChat = vi.fn(
      (input: {
        baseUrl: string;
        apiKey: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('NVIDIA reply.');
        return Promise.resolve({
          content: 'NVIDIA reply.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-nvidia-test',
      nvidiaModels: ['meta/llama-3.1-8b-instruct'],
      nvidiaStreamChat
    });

    try {
      harness.settingsService.update({
        textInferenceBackend: 'nvidia',
        nvidiaApiKey: 'nvapi-test',
        defaultModel: 'meta/llama-3.1-8b-instruct'
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Explain the selected backend.',
          model: 'meta/llama-3.1-8b-instruct'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const latestMessages = harness.repository.listMessages(accepted.conversation.id);
        expect(latestMessages.at(-1)?.status).toBe('completed');
      });

      expect(harness.nvidiaClient.streamChat).toHaveBeenCalledTimes(1);
      expect(harness.ollamaClient.streamChat).not.toHaveBeenCalled();
      expect(harness.nvidiaClient.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          apiKey: 'nvapi-test',
          model: 'meta/llama-3.1-8b-instruct'
        })
      );
    } finally {
      harness.database.close();
    }
  });

  it('recovers provider-emitted inline tool-call markup instead of leaving it in the transcript', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-inline-tool-recovery-'));
    tempDirectories.push(directory);

    const workspaceRoot = path.join(directory, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, 'README.md'), '# Existing README\n', 'utf8');
    writeFileSync(path.join(workspaceRoot, 'src.ts'), 'export const value = 1;\n', 'utf8');

    let streamCallCount = 0;
    let completeCallCount = 0;
    const nvidiaStreamChat = vi.fn(
      (input: {
        baseUrl: string;
        apiKey: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
        }>;
        onDelta: (delta: string) => void;
      }) => {
        streamCallCount += 1;

        const reply = [
          "I'll inspect the workspace first.",
          '<|tool_calls_section_begin|>',
          '<|tool_call_begin|> functions.workspace-lister.0',
          `<|tool_call_argument_begin|> {"path":"${workspaceRoot.replace(/\\/g, '\\\\')}"}`,
          '<|tool_call_end|>',
          '<|tool_calls_section_end|>'
        ].join(' ');

        input.onDelta(reply);

        return Promise.resolve({
          content: reply,
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const nvidiaCompleteChat = vi.fn(
      (input: {
        baseUrl: string;
        apiKey: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
        }>;
      }) => {
        completeCallCount += 1;

        expect(
          input.messages.some(
            (message) =>
              message.role === 'system' &&
              message.content.includes('Tool results:') &&
              message.content.includes('Workspace Lister')
          )
        ).toBe(true);

        return Promise.resolve({
          content: 'I inspected the workspace and can now continue with the README summary.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-tool-recovery-test',
      nvidiaModels: ['moonshotai/kimi-k2-thinking'],
      nvidiaStreamChat,
      nvidiaCompleteChat
    });

    try {
      harness.settingsService.update({
        textInferenceBackend: 'nvidia',
        nvidiaApiKey: 'nvapi-test',
        defaultModel: 'moonshotai/kimi-k2-thinking'
      });

      const workspace = harness.repository.createWorkspace({
        name: 'Inline Tool Recovery',
        rootPath: workspaceRoot
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Check the code and write a detailed summary of the implementation in readme.md file.',
          workspaceId: workspace.id,
          model: 'moonshotai/kimi-k2-thinking'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const latestMessages = harness.service.listMessages(accepted.conversation.id);
        expect(latestMessages.at(-1)?.status).toBe('completed');
      });

      const finalAssistant = harness.service.listMessages(accepted.conversation.id).at(-1);

      expect(streamCallCount).toBe(1);
      expect(completeCallCount).toBe(1);
      expect(finalAssistant?.content).toContain(
        'I inspected the workspace and can now continue with the README summary.'
      );
      expect(finalAssistant?.content).not.toContain('<|tool_call_begin|>');
      expect(
        finalAssistant?.toolInvocations?.some(
          (invocation) => invocation.toolId === 'workspace-lister'
        )
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it('sends the latest user turn as a structured markdown prompt with workspace and tools', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-structured-prompt-'));
    tempDirectories.push(directory);

    let capturedMessages:
      | Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>
      | undefined;
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        capturedMessages = input.messages;
        input.onDelta('Structured prompt received.');
        return Promise.resolve({
          content: 'Structured prompt received.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-structured-prompt-test',
      streamChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.createWorkspace({
        name: 'Workspace Prompt Test',
        prompt: 'Stay grounded in the selected workspace.',
        rootPath: workspaceRoot
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Reply with the selected workspace path.',
          workspaceId: workspace.id,
          model: 'llama3.2:latest'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        expect(capturedMessages).toBeDefined();
      });
      await vi.waitFor(() => {
        const latestMessages = harness.repository.listMessages(accepted.conversation.id);
        expect(latestMessages.at(-1)?.status).toBe('completed');
      });

      const capabilityPrompt = capturedMessages?.find(
        (message) => message.role === 'system' && message.content.includes('Capability catalog')
      );
      const latestUserMessage = capturedMessages
        ?.filter((message) => message.role === 'user')
        .at(-1);

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(latestUserMessage?.content).toContain('# Prompt');
      expect(latestUserMessage?.content).toContain('Reply with the selected workspace path.');
      expect(latestUserMessage?.content).toContain('# Workspace');
      expect(latestUserMessage?.content).toContain(`\`${workspaceRoot}\``);
      expect(capabilityPrompt?.content).toContain('You are Helix, created by Abstergo.');
      expect(capabilityPrompt?.content).toContain('Available tools');
      expect(capabilityPrompt?.content).toContain('`workspace-search`');
      expect(capabilityPrompt?.content).toContain('Command `/grep`');
      expect(capabilityPrompt?.content).toContain('Available skills');
    } finally {
      harness.database.close();
    }
  });

  it('keeps image-analysis prompts with attached images on the chat path and routes them to the vision model', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-vision-auto-'));
    tempDirectories.push(directory);

    let capturedInput: VisionStreamCall | undefined;
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        capturedInput = {
          model: input.model,
          messages: input.messages
        };

        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-vision-auto-test',
      models: ['llama3.2:latest', 'qwen3-vl:8b'],
      streamChat
    });

    try {
      const imagePath = path.join(directory, 'subject.png');
      const imageBytes = Buffer.from([5, 6, 7, 8]);
      writeFileSync(imagePath, imageBytes);

      const attachments = await harness.service.prepareAttachments([imagePath]);
      const accepted = await harness.service.submitPrompt(
        {
          prompt: 'Describe this image',
          model: 'llama3.2:latest',
          attachments
        },
        () => undefined
      );

      expect(accepted.kind).toBe('chat');

      await vi.waitFor(() => {
        expect(capturedInput).toBeDefined();
      });

      if (!capturedInput) {
        throw new Error('Expected multimodal Ollama input to be captured.');
      }

      const userMessage = capturedInput.messages.find((message) => message.role === 'user');

      expect(capturedInput.model).toBe('qwen3-vl:8b');
      expect(userMessage?.images).toEqual([imageBytes.toString('base64')]);
    } finally {
      harness.database.close();
    }
  });

  it('asks for confirmation before dispatching text-to-image prompts with no image attachments', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-'));
    tempDirectories.push(directory);
    const startImageJob = vi.fn(
      (input: Parameters<GenerationService['startImageJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000001',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'image' as const,
            mode: input.mode ?? 'text-to-image',
            workflowProfile: 'default' as const,
            status: 'queued' as const,
            prompt: input.prompt,
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
            stage: 'Queued',
            errorMessage: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            referenceImages: [],
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-generation-test',
      generationService: { startImageJob }
    });

    try {
      const accepted = await harness.service.submitPrompt(
        {
          prompt: 'Generate an image of a neon cat wearing armor'
        },
        () => undefined
      );

      expect(startImageJob).not.toHaveBeenCalled();
      expect(accepted.kind).toBe('generation-confirmation');

      if (accepted.kind !== 'generation-confirmation') {
        throw new Error('Expected a generation confirmation result.');
      }

      expect(accepted.options.map((option) => option.label)).toEqual([
        'Generate Image',
        'Continue Chat'
      ]);
      expect(accepted.conversation.title).toContain('Generate an image');

      const confirmed = await harness.service.confirmGenerationIntent(
        {
          conversationId: accepted.conversation.id,
          prompt: accepted.prompt,
          attachments: accepted.attachments,
          selection: 'image'
        },
        () => undefined
      );

      expect(startImageJob).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Generate an image of a neon cat wearing armor',
          mode: 'text-to-image',
          referenceImages: []
        })
      );
      expect(confirmed.kind).toBe('generation');
    } finally {
      harness.database.close();
    }
  });

  it('still asks for generation confirmation when a general chat model is selected', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-selected-'));
    tempDirectories.push(directory);
    const startImageJob = vi.fn(
      (input: Parameters<GenerationService['startImageJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000011',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'image' as const,
            mode: input.mode ?? 'text-to-image',
            workflowProfile: 'default' as const,
            status: 'queued' as const,
            prompt: input.prompt,
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
            stage: 'Queued',
            errorMessage: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            referenceImages: [],
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-selected-model-test',
      generationService: { startImageJob }
    });

    try {
      const accepted = await harness.service.submitPrompt(
        {
          prompt: 'Generate an image of a neon cat wearing armor',
          model: 'llama3.2:latest'
        },
        () => undefined
      );

      expect(startImageJob).not.toHaveBeenCalled();
      expect(accepted.kind).toBe('generation-confirmation');
    } finally {
      harness.database.close();
    }
  });

  it('keeps code-delivery prompts with wallpaper requirements on the chat path instead of auto-starting image generation', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-code-prompt-'));
    tempDirectories.push(directory);
    const startImageJob = vi.fn();
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('Implemented response on the normal chat path.');
        return Promise.resolve({
          content: 'Implemented response on the normal chat path.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-code-prompt-test',
      streamChat,
      generationService: { startImageJob }
    });

    try {
      const prompt = `Using HTML, CSS, and JavaScript, generate a browser OS with these features:

At least 5 applications
2 of the 5 applications must be functional 3D games
One game must be a simple GTA clone
The other 3D game can be anything
Ability to change wallpaper
One special feature of your choice, and document what it is and why it is special
Everything must be contained in a single script/file
Must run in Chrome browser`;

      const accepted = await harness.service.submitPrompt(
        {
          prompt
        },
        () => undefined
      );

      expect(accepted.kind).toBe('chat');
      expect(startImageJob).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(streamChat.mock.calls.length).toBeGreaterThan(0);
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.routeTrace?.activeSkillId).toBe('builder');
      expect(assistantMessage?.routeTrace?.activeToolId).toBeNull();
    } finally {
      harness.database.close();
    }
  });

  it('returns image previews through the bridge-safe preview API', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-preview-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-preview-test'
    });

    try {
      const imagePath = path.join(directory, 'preview.png');
      const imageBytes = Buffer.from([1, 2, 3, 4]);
      writeFileSync(imagePath, imageBytes);

      await harness.service.prepareAttachments([imagePath]);
      const preview = await harness.service.getAttachmentPreview(imagePath);

      expect(preview.mimeType).toBe('image/png');
      expect(preview.dataUrl).toBe(
        `data:image/png;base64,${imageBytes.toString('base64')}`
      );
    } finally {
      harness.database.close();
    }
  });

  it('asks for confirmation, then reuses the latest generated image for follow-up edit prompts without new attachments', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-edit-'));
    tempDirectories.push(directory);
    const startImageJob = vi.fn(
      (input: Parameters<GenerationService['startImageJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000002',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'image' as const,
            mode: input.mode ?? 'text-to-image',
            workflowProfile: 'qwen-image-edit-2511' as const,
            status: 'queued' as const,
            prompt: input.prompt,
            negativePrompt: null,
            model: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
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
            referenceImages: (input.referenceImages ?? []).map((attachment, index) => ({
              id: `83000000-0000-4000-8000-00000000000${index + 1}`,
              fileName: path.basename(attachment.filePath ?? `reference-${index}.png`),
              filePath: attachment.filePath,
              mimeType: 'image/png',
              sizeBytes: 4,
              extractedText: null,
              createdAt: '2026-04-09T00:00:00.000Z'
            })),
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-follow-up-test',
      generationService: { startImageJob }
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Generate an outfit reference',
        workspaceId: workspace.id
      });
      const generatedImagePath = path.join(directory, 'generated-outfit.png');
      writeFileSync(generatedImagePath, Buffer.from([1, 2, 3, 4]));

      const priorJob = harness.generationRepository.upsertJob({
        id: '82000000-0000-4000-8000-000000000001',
        workspaceId: workspace.id,
        conversationId: conversation.id,
        kind: 'image',
        mode: 'text-to-image',
        workflowProfile: 'default',
        status: 'completed',
        prompt: 'Generate an outfit reference',
        negativePrompt: null,
        model: 'builtin:placeholder',
        backend: 'placeholder',
        width: 768,
        height: 768,
        steps: 6,
        guidanceScale: 4,
        seed: null,
        progress: 1,
        stage: 'Completed',
        errorMessage: null,
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:05.000Z',
        startedAt: '2026-04-09T00:00:00.000Z',
        completedAt: '2026-04-09T00:00:05.000Z',
        referenceImages: []
      });
      harness.generationRepository.replaceArtifacts(priorJob.id, [
        {
          id: '82000000-0000-4000-8000-000000000002',
          jobId: priorJob.id,
          kind: 'image',
          filePath: generatedImagePath,
          previewPath: null,
          mimeType: 'image/png',
          width: 768,
          height: 768,
          createdAt: '2026-04-09T00:00:05.000Z'
        }
      ]);

      const accepted = await harness.service.submitPrompt(
        {
          conversationId: conversation.id,
          prompt: 'Now swap their clothing'
        },
        () => undefined
      );

      expect(startImageJob).not.toHaveBeenCalled();
      expect(accepted.kind).toBe('generation-confirmation');

      if (accepted.kind !== 'generation-confirmation') {
        throw new Error('Expected a generation confirmation result for the follow-up edit.');
      }

      expect(accepted.options.map((option) => option.label)).toEqual([
        'Generate Image',
        'Continue Chat'
      ]);

      const confirmed = await harness.service.confirmGenerationIntent(
        {
          conversationId: accepted.conversation.id,
          prompt: accepted.prompt,
          attachments: accepted.attachments,
          selection: 'image'
        },
        () => undefined
      );

      expect(startImageJob).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: conversation.id,
          prompt: 'Now swap their clothing',
          mode: 'image-to-image'
        })
      );

      const firstCall = startImageJob.mock.calls[0]?.[0];
      expect(firstCall?.referenceImages ?? []).toHaveLength(1);
      expect(firstCall?.referenceImages?.[0]?.filePath).toBe(generatedImagePath);
      expect(confirmed.kind).toBe('generation');
    } finally {
      harness.database.close();
    }
  });

  it('shows edit and video confirmation options when exactly one image is attached', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-restore-'));
    tempDirectories.push(directory);
    const startImageJob = vi.fn(
      (input: Parameters<GenerationService['startImageJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000021',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'image' as const,
            mode: input.mode ?? 'text-to-image',
            workflowProfile: 'qwen-image-edit-2511' as const,
            status: 'queued' as const,
            prompt: input.prompt,
            negativePrompt: null,
            model: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
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
            referenceImages: (input.referenceImages ?? []).map((attachment, index) => ({
              id: `83000000-0000-4000-8000-00000000001${index + 1}`,
              fileName: path.basename(attachment.filePath ?? `reference-${index}.png`),
              filePath: attachment.filePath,
              mimeType: 'image/png',
              sizeBytes: 4,
              extractedText: null,
              createdAt: '2026-04-09T00:00:00.000Z'
            })),
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-restore-follow-up-test',
      generationService: { startImageJob }
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Describe her clothing',
        workspaceId: workspace.id
      });
      const originalImagePath = path.join(directory, 'original-outfit.png');
      const editedImagePath = path.join(directory, 'edited-black-shirt.png');
      writeFileSync(originalImagePath, Buffer.from([1, 2, 3, 4]));
      writeFileSync(editedImagePath, Buffer.from([4, 3, 2, 1]));

      const originalReferenceImages = await harness.service.prepareAttachments([originalImagePath]);
      const currentEditedImage = await harness.service.prepareAttachments([editedImagePath]);
      const priorJob = harness.generationRepository.upsertJob({
        id: '82000000-0000-4000-8000-000000000021',
        workspaceId: workspace.id,
        conversationId: conversation.id,
        kind: 'image',
        mode: 'image-to-image',
        workflowProfile: 'qwen-image-edit-2511',
        status: 'completed',
        prompt: 'Change her clothing to black t-shirt',
        negativePrompt: null,
        model: 'E:/LocalModels/diffusion_models/Qwen-Image-Edit-2511-Q8_0.gguf',
        backend: 'comfyui',
        width: 1664,
        height: 1248,
        steps: 4,
        guidanceScale: 1,
        seed: null,
        progress: 1,
        stage: 'Completed',
        errorMessage: null,
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:05.000Z',
        startedAt: '2026-04-09T00:00:00.000Z',
        completedAt: '2026-04-09T00:00:05.000Z',
        referenceImages: originalReferenceImages
      });
      harness.generationRepository.replaceArtifacts(priorJob.id, [
        {
          id: '82000000-0000-4000-8000-000000000022',
          jobId: priorJob.id,
          kind: 'image',
          filePath: editedImagePath,
          previewPath: null,
          mimeType: 'image/png',
          width: 1664,
          height: 1248,
          createdAt: '2026-04-09T00:00:05.000Z'
        }
      ]);

      const accepted = await harness.service.submitPrompt(
        {
          conversationId: conversation.id,
          prompt: 'Now change it back to original',
          attachments: currentEditedImage
        },
        () => undefined
      );

      expect(startImageJob).not.toHaveBeenCalled();
      expect(accepted.kind).toBe('generation-confirmation');

      if (accepted.kind !== 'generation-confirmation') {
        throw new Error('Expected a generation confirmation result for the restore-style edit.');
      }

      expect(accepted.options.map((option) => option.label)).toEqual([
        'Edit Image',
        'Generate Video',
        'Continue Chat'
      ]);

      const confirmed = await harness.service.confirmGenerationIntent(
        {
          conversationId: accepted.conversation.id,
          prompt: accepted.prompt,
          attachments: accepted.attachments,
          selection: 'image'
        },
        () => undefined
      );

      expect(startImageJob).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: conversation.id,
          mode: 'image-to-image'
        })
      );

      const firstCall = startImageJob.mock.calls[0]?.[0];
      expect(firstCall?.prompt).toContain(
        'use the first reference image as the current image to edit'
      );
      expect(firstCall?.referenceImages ?? []).toHaveLength(2);
      expect(firstCall?.referenceImages?.[0]?.filePath).toBe(editedImagePath);
      expect(firstCall?.referenceImages?.[1]?.filePath).toBe(originalImagePath);
      expect(confirmed.kind).toBe('generation');
    } finally {
      harness.database.close();
    }
  });

  it('starts a video job after the user confirms the single-image video option', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-confirm-video-'));
    tempDirectories.push(directory);
    const startVideoJob = vi.fn(
      (input: Parameters<GenerationService['startVideoJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000031',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'video' as const,
            mode: 'image-to-video' as const,
            workflowProfile: 'wan-image-to-video' as const,
            status: 'queued' as const,
            prompt: input.prompt,
            negativePrompt: null,
            model: 'E:/LocalModels/diffusion_models/wan-high.gguf',
            backend: 'comfyui' as const,
            width: 528,
            height: 704,
            steps: 8,
            guidanceScale: 1,
            seed: null,
            frameCount: 81,
            frameRate: 16,
            progress: 0,
            stage: 'Queued',
            errorMessage: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            referenceImages: input.referenceImages.map((attachment, index) => ({
              id: `83000000-0000-4000-8000-00000000002${index + 1}`,
              fileName: path.basename(attachment.filePath ?? `reference-${index}.png`),
              filePath: attachment.filePath,
              mimeType: 'image/png',
              sizeBytes: 4,
              extractedText: null,
              createdAt: '2026-04-09T00:00:00.000Z'
            })),
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'confirm-video-generation-test',
      generationService: { startVideoJob }
    });

    try {
      const imagePath = path.join(directory, 'portrait.png');
      writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
      const attachments = await harness.service.prepareAttachments([imagePath]);

      const accepted = await harness.service.submitPrompt(
        {
          prompt: 'Animate this portrait with a slow dolly-in.',
          attachments
        },
        () => undefined
      );

      expect(accepted.kind).toBe('generation-confirmation');

      if (accepted.kind !== 'generation-confirmation') {
        throw new Error('Expected a generation confirmation result for the video prompt.');
      }

      const confirmed = await harness.service.confirmGenerationIntent(
        {
          conversationId: accepted.conversation.id,
          prompt: accepted.prompt,
          attachments: accepted.attachments,
          selection: 'video'
        },
        () => undefined
      );

      expect(startVideoJob).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: accepted.conversation.id,
          prompt: 'Animate this portrait with a slow dolly-in.'
        })
      );
      expect(startVideoJob.mock.calls[0]?.[0]?.referenceImages).toHaveLength(1);
      expect(startVideoJob.mock.calls[0]?.[0]?.referenceImages?.[0]?.filePath).toBe(imagePath);
      expect(confirmed.kind).toBe('generation');
    } finally {
      harness.database.close();
    }
  });

  it('offers edit, video, and chat options for multi-image confirmations and seeds video from the first image', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-confirm-multi-image-'));
    tempDirectories.push(directory);
    const startVideoJob = vi.fn(
      (input: Parameters<GenerationService['startVideoJob']>[0]) =>
        Promise.resolve({
          job: {
            id: '81000000-0000-4000-8000-000000000032',
            workspaceId: null,
            conversationId: input.conversationId ?? null,
            kind: 'video' as const,
            mode: 'image-to-video' as const,
            workflowProfile: 'wan-image-to-video' as const,
            status: 'queued' as const,
            prompt: input.prompt,
            negativePrompt: null,
            model: 'E:/LocalModels/diffusion_models/wan-high.gguf',
            backend: 'comfyui' as const,
            width: 528,
            height: 704,
            steps: 8,
            guidanceScale: 1,
            seed: null,
            frameCount: 81,
            frameRate: 16,
            progress: 0,
            stage: 'Queued',
            errorMessage: null,
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            referenceImages: input.referenceImages.map((attachment, index) => ({
              id: `83000000-0000-4000-8000-00000000003${index + 1}`,
              fileName: path.basename(attachment.filePath ?? `reference-${index}.png`),
              filePath: attachment.filePath,
              mimeType: 'image/png',
              sizeBytes: 4,
              extractedText: null,
              createdAt: '2026-04-09T00:00:00.000Z'
            })),
            artifacts: []
          }
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'confirm-multi-image-test',
      generationService: { startImageJob: vi.fn(), startVideoJob }
    });

    try {
      const imagePaths = [
        path.join(directory, 'reference-a.png'),
        path.join(directory, 'reference-b.png')
      ];
      for (const imagePath of imagePaths) {
        writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
      }
      const attachments = await harness.service.prepareAttachments(imagePaths);

      const accepted = await harness.service.submitPrompt(
        {
          prompt: 'Blend these references into one polished result.',
          attachments
        },
        () => undefined
      );

      expect(accepted.kind).toBe('generation-confirmation');

      if (accepted.kind !== 'generation-confirmation') {
        throw new Error('Expected a generation confirmation result for multiple references.');
      }

      expect(accepted.options.map((option) => option.label)).toEqual([
        'Edit Images',
        'Generate Video',
        'Continue Chat'
      ]);

      const confirmed = await harness.service.confirmGenerationIntent(
        {
          conversationId: accepted.conversation.id,
          prompt: accepted.prompt,
          attachments: accepted.attachments,
          selection: 'video'
        },
        () => undefined
      );

      expect(startVideoJob).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: accepted.conversation.id,
          prompt: 'Blend these references into one polished result.'
        })
      );
      expect(startVideoJob.mock.calls[0]?.[0]?.referenceImages).toHaveLength(1);
      expect(startVideoJob.mock.calls[0]?.[0]?.referenceImages?.[0]?.filePath).toBe(
        imagePaths[0]
      );
      expect(confirmed.kind).toBe('generation');
    } finally {
      harness.database.close();
    }
  });

  it('keeps image-prompt authoring follow-ups on the chat path instead of auto-starting generation', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-auto-image-prompting-'));
    tempDirectories.push(directory);

    const startImageJob = vi.fn();
    const completeChat = vi.fn().mockResolvedValue({
      content:
        '{"toolId":null,"skillId":null,"needsVision":false,"prefersCode":false,"useWorkspaceKnowledge":false,"imageMode":"prompt-authoring","confidence":0.94,"reason":"user wants an image prompt, not an image job"}',
      doneReason: 'stop'
    });
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta(
          'A cinematic image-generation prompt describing the same outfit on an Indian woman.'
        );
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'auto-image-prompt-authoring-test',
      models: ['llama3.2:latest', 'qwen3-vl:8b'],
      streamChat,
      completeChat,
      generationService: { startImageJob }
    });

    try {
      const imagePath = path.join(directory, 'outfit-reference.png');
      writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
      const attachments = await harness.service.prepareAttachments([imagePath]);
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Describe her clothing in great detail',
        workspaceId: workspace.id
      });

      harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Describe her clothing in great detail',
        attachments,
        status: 'completed',
        model: 'qwen3-vl:8b'
      });
      harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Detailed clothing description.',
        attachments: [],
        status: 'completed',
        model: 'qwen3-vl:8b'
      });

      const accepted = await harness.service.submitPrompt(
        {
          conversationId: conversation.id,
          prompt: 'Create an image generation prompt for same clothing on an Indian woman'
        },
        () => undefined
      );

      expect(accepted.kind).toBe('chat');
      expect(startImageJob).not.toHaveBeenCalled();

      if (accepted.kind !== 'chat') {
        throw new Error('Expected the follow-up prompt request to stay on the chat path.');
      }

      await vi.waitFor(() => {
        expect(streamChat).toHaveBeenCalledTimes(1);
      });
      expect(completeChat).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });
    } finally {
      harness.database.close();
    }
  });

  it('keeps Wan 2.2 prompt-authoring requests on the chat path instead of direct workspace opener routing', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-wan-prompt-routing-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta(
          'Wan 2.2 prompt: cinematic subject motion, anchored camera move, detailed environment, coherent temporal action.'
        );
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const openWorkspacePath = vi.fn<WorkspacePathLauncher>().mockResolvedValue('');
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'wan-prompt-chat-route-test',
      models: ['llama3.2:latest'],
      streamChat,
      openWorkspacePath
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.submitPrompt(
        {
          workspaceId: workspace.id,
          prompt:
            'Generate a prompt for Wan 2.2 image to video model. Start with a dynamic orbit shot.'
        },
        () => undefined
      );

      expect(accepted.kind).toBe('chat');

      if (accepted.kind !== 'chat') {
        throw new Error('Expected the Wan prompt request to stay on the chat path.');
      }

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        const assistantMessage = messages.at(-1);

        expect(assistantMessage?.status).toBe('completed');
        expect(assistantMessage?.routeTrace?.activeToolId).toBeNull();
        expect(assistantMessage?.routeTrace?.strategy).toBe('chat');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(openWorkspacePath).not.toHaveBeenCalled();
      expect(assistantMessage?.content).toContain('Wan 2.2 prompt: cinematic subject motion');
      expect(assistantMessage?.model).toBe('llama3.2:latest');
    } finally {
      harness.database.close();
    }
  });

  it('keeps attached-image Wan 2.2 prompt-authoring requests on the chat path', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-wan-image-prompt-routing-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta(
          'Wan 2.2 image-to-video prompt with subject continuity, grounded motion cues, and camera path guidance.'
        );
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const openWorkspacePath = vi.fn<WorkspacePathLauncher>().mockResolvedValue('');
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'wan-image-prompt-chat-route-test',
      models: ['llama3.2:latest', 'qwen3-vl:8b'],
      streamChat,
      openWorkspacePath
    });

    try {
      harness.settingsService.update({
        visionModel: 'qwen3-vl:8b'
      });

      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      const imagePath = path.join(directory, 'reference-image.png');
      writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

      const attachments = await harness.service.prepareAttachments([imagePath]);
      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.submitPrompt(
        {
          workspaceId: workspace.id,
          prompt: 'for this image generate a prompt for wan2.2 image to video model.',
          attachments
        },
        () => undefined
      );

      expect(accepted.kind).toBe('chat');

      if (accepted.kind !== 'chat') {
        throw new Error('Expected the attached-image Wan prompt request to stay on the chat path.');
      }

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        const assistantMessage = messages.at(-1);

        expect(assistantMessage?.status).toBe('completed');
        expect(assistantMessage?.routeTrace?.activeToolId).toBeNull();
        expect(assistantMessage?.routeTrace?.strategy).toBe('chat');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const userMessage = messages.find((message) => message.role === 'user');

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(openWorkspacePath).not.toHaveBeenCalled();
      expect(assistantMessage?.content).toContain('Wan 2.2 image-to-video prompt');
      expect(assistantMessage?.model).toBe('qwen3-vl:8b');
      expect(userMessage?.attachments).toHaveLength(1);
    } finally {
      harness.database.close();
    }
  });

  it('returns image previews for persisted generation artifacts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-generation-preview-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'generation-preview-test'
    });

    try {
      const imagePath = path.join(directory, 'generated.png');
      const previewPath = path.join(directory, 'generated-preview.png');
      const imageBytes = Buffer.from([1, 2, 3, 4, 5]);
      writeFileSync(imagePath, imageBytes);
      writeFileSync(previewPath, imageBytes);

      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Generate an image',
        workspaceId: workspace.id
      });
      const job = harness.generationRepository.upsertJob({
        id: '71000000-0000-4000-8000-000000000001',
        workspaceId: workspace.id,
        conversationId: conversation.id,
        kind: 'image',
        mode: 'text-to-image',
        workflowProfile: 'default',
        status: 'completed',
        prompt: 'Generate an image',
        negativePrompt: null,
        model: 'builtin:placeholder',
        backend: 'placeholder',
        width: 768,
        height: 768,
        steps: 6,
        guidanceScale: 4,
        seed: null,
        progress: 1,
        stage: 'Completed',
        errorMessage: null,
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:01.000Z',
        startedAt: '2026-04-09T00:00:00.000Z',
        completedAt: '2026-04-09T00:00:01.000Z',
        referenceImages: []
      });
      harness.generationRepository.replaceArtifacts(job.id, [
        {
          id: '72000000-0000-4000-8000-000000000001',
          jobId: job.id,
          kind: 'image',
          filePath: imagePath,
          previewPath,
          mimeType: 'image/png',
          width: 768,
          height: 768,
          createdAt: '2026-04-09T00:00:01.000Z'
        }
      ]);

      const preview = await harness.service.getAttachmentPreview(previewPath);

      expect(preview.mimeType).toBe('image/png');
      expect(preview.dataUrl).toBe(
        `data:image/png;base64,${imageBytes.toString('base64')}`
      );
    } finally {
      harness.database.close();
    }
  });

  it('completes a streaming assistant turn with partial content when cancelled', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-chat-cancel-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
        signal?: AbortSignal;
      }) =>
        new Promise<{ doneReason: string | null }>((resolve, reject) => {
          input.onDelta('Partial reply');
          input.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true }
          );

          setTimeout(() => resolve({ doneReason: 'stop' }), 1_000);
        })
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-cancel-test',
      models: ['llama3.2:latest'],
      streamChat
    });

    try {
      const emittedEvents: Array<{
        type: string;
        assistantMessageId: string;
        content?: string;
        doneReason?: string | null;
      }> = [];
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Write a longer answer about cancellation testing.'
        },
        (event) => {
          emittedEvents.push(event);
        }
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.content).toBe('Partial reply');
      });

      harness.service.cancelChatTurn({
        assistantMessageId: accepted.assistantMessage.id
      });

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        const latestMessage = messages.at(-1);

        expect(latestMessage?.id).toBe(accepted.assistantMessage.id);
        expect(latestMessage?.status).toBe('completed');
        expect(latestMessage?.content).toBe('Partial reply');
      });

      await vi.waitFor(() => {
        expect(
          emittedEvents.some(
            (event) =>
              event.type === 'complete' &&
              event.assistantMessageId === accepted.assistantMessage.id &&
              event.content === 'Partial reply' &&
              event.doneReason === 'cancelled'
          )
        ).toBe(true);
      });
    } finally {
      harness.database.close();
    }
  });

  it('validates and de-duplicates connected workspace folders', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-workspace-root-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-workspace-root-test'
    });

    try {
      const projectAlpha = path.join(directory, 'project-alpha');
      const projectBeta = path.join(directory, 'project-beta');
      const projectGamma = path.join(directory, 'project-gamma');
      mkdirSync(projectAlpha, { recursive: true });
      mkdirSync(projectBeta, { recursive: true });
      mkdirSync(projectGamma, { recursive: true });

      const alphaWorkspace = await harness.service.createWorkspace({
        name: 'Project Alpha',
        rootPath: projectAlpha
      });

      expect(alphaWorkspace.rootPath).toBe(projectAlpha);

      await expect(
        harness.service.createWorkspace({
          name: 'Duplicate Alpha',
          rootPath: projectAlpha
        })
      ).rejects.toThrow('already connected');

      const betaWorkspace = await harness.service.createWorkspace({
        name: 'Project Beta',
        rootPath: projectGamma
      });
      const updatedAlpha = await harness.service.updateWorkspaceRoot({
        workspaceId: alphaWorkspace.id,
        rootPath: projectBeta
      });

      expect(updatedAlpha.rootPath).toBe(projectBeta);

      await expect(
        harness.service.updateWorkspaceRoot({
          workspaceId: betaWorkspace.id,
          rootPath: projectBeta
        })
      ).rejects.toThrow('already connected');
    } finally {
      harness.database.close();
    }
  });

  it('executes native Ollama tool calls before finalizing a chat reply', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-native-tools-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'calculator',
              arguments: {
                expression: '2 + 4'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'The answer is 6.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-native-tool-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Double-check the value of 2 + 4 using a tool if you need to.'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe('The answer is 6.');
      expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('calculator');
      expect(assistantMessage?.toolInvocations?.[0]?.status).toBe('completed');
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('streams plan-mode and task snapshots after native tool calls mutate them', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-plan-stream-'));
    tempDirectories.push(directory);
    const streamEvents: ChatStreamEvent[] = [];
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'enter-plan-mode',
              arguments: {}
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'task-create',
              arguments: {
                title: 'Inspect routing flow',
                details: 'Trace plan/task stream updates.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Plan is ready.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-plan-stream-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      harness.capabilityService.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Use plan mode and create a task for inspecting routing before answering.'
        },
        (event) => {
          streamEvents.push(event);
        }
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(
        streamEvents.some(
          (event) =>
            event.type === 'update' && event.capabilityPlanState?.status === 'active'
        )
      ).toBe(true);
      expect(
        streamEvents.some(
          (event) =>
            event.type === 'update' &&
            event.capabilityTasks?.some((task) => task.title === 'Inspect routing flow')
        )
      ).toBe(true);
      expect(
        streamEvents.some(
          (event) =>
            event.type === 'complete' &&
            event.capabilityPlanState?.status === 'active' &&
            event.capabilityTasks?.some((task) => task.title === 'Inspect routing flow')
        )
      ).toBe(true);
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('does not execute plain-text slash commands without an explicit recovery marker', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-inline-text-command-guard-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-text-command-guard-test',
      models: ['glm-5:cloud']
    });

    try {
      harness.capabilityService.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });

      const result = await (
        harness.service as unknown as {
          recoverInlineToolCalls: (input: {
            backend: 'ollama' | 'nvidia';
            baseUrl: string;
            apiKey: string | null;
            model: string;
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            content: string;
            doneReason: string | null;
            workspaceRootPath: string | null;
            workspaceId: string | null;
            conversationId: string;
            allowAutoToolExecution?: boolean;
          }) => Promise<{
            content: string;
            doneReason: string | null;
            toolInvocations: Array<{ toolId: string }>;
            contextSources: unknown[];
          }>;
        }
      ).recoverInlineToolCalls({
        backend: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: null,
        model: 'glm-5:cloud',
        messages: [
          {
            role: 'system',
            content: 'Normal tool guidance without a recovery marker.'
          }
        ],
        content: 'Use `/task-create {"title":"Ship Milestone 4.1"}` to create the task.',
        doneReason: 'stop',
        workspaceRootPath: null,
        workspaceId: null,
        conversationId: 'conversation-1'
      });

      expect(result.content).toContain('/task-create {"title":"Ship Milestone 4.1"}');
      expect(result.toolInvocations).toHaveLength(0);
      expect(harness.capabilityService.listTasks(null)).toHaveLength(0);
    } finally {
      harness.database.close();
    }
  });

  it('auto-recovers command-only parenthesized slash commands with stray think tags', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'ollama-desktop-inline-text-command-command-only-')
    );
    tempDirectories.push(directory);
    const workspaceRoot = path.join(directory, 'blog-export');
    mkdirSync(path.join(workspaceRoot, 'posts'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, 'posts', 'article.md'), '# Draft blog post\n', 'utf8');
    const completeChat = vi.fn().mockResolvedValue({
      content: 'I inspected the connected blog workspace and can continue with the gap analysis.',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-text-command-command-only-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      const result = await (
        harness.service as unknown as {
          recoverInlineToolCalls: (input: {
            backend: 'ollama' | 'nvidia';
            baseUrl: string;
            apiKey: string | null;
            model: string;
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            content: string;
            doneReason: string | null;
            workspaceRootPath: string | null;
            workspaceId: string | null;
            conversationId: string;
            allowAutoToolExecution?: boolean;
          }) => Promise<{
            content: string;
            doneReason: string | null;
            toolInvocations: Array<{ toolId: string; status: string }>;
            contextSources: unknown[];
          }>;
        }
      ).recoverInlineToolCalls({
        backend: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: null,
        model: 'glm-5:cloud',
        messages: [
          {
            role: 'system',
            content: 'Normal tool guidance without an explicit text-command recovery marker.'
          }
        ],
        content: `/workspace-lister </think>\n\n/workspace-lister(path="${workspaceRoot.replace(/\\/g, '\\\\')}")`,
        doneReason: 'stop',
        workspaceRootPath: workspaceRoot,
        workspaceId: null,
        conversationId: 'conversation-command-only',
        allowAutoToolExecution: true
      });

      expect(result.content).toBe(
        'I inspected the connected blog workspace and can continue with the gap analysis.'
      );
      expect(result.toolInvocations.map((invocation) => `${invocation.toolId}:${invocation.status}`)).toEqual([
        'workspace-lister:completed'
      ]);
      expect(result.contextSources.length).toBeGreaterThan(0);
      expect(completeChat).toHaveBeenCalledTimes(1);
    } finally {
      harness.database.close();
    }
  });

  it('auto-recovers command-only JSON tool_calls output', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'ollama-desktop-inline-json-tool-calls-')
    );
    tempDirectories.push(directory);
    const workspaceRoot = path.join(directory, 'workspace-root');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, 'how_transformers_actually_work_fact_checked.md'),
      '# Fact checked blog\n\nNeeds clearer framing.\n',
      'utf8'
    );
    const completeChat = vi.fn().mockResolvedValue({
      content: 'I read the fact-checked blog draft and can now list the missing sections.',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-json-tool-calls-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      const result = await (
        harness.service as unknown as {
          recoverInlineToolCalls: (input: {
            backend: 'ollama' | 'nvidia';
            baseUrl: string;
            apiKey: string | null;
            model: string;
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            content: string;
            doneReason: string | null;
            workspaceRootPath: string | null;
            workspaceId: string | null;
            conversationId: string;
            allowAutoToolExecution?: boolean;
          }) => Promise<{
            content: string;
            doneReason: string | null;
            toolInvocations: Array<{ toolId: string; status: string }>;
            contextSources: unknown[];
          }>;
        }
      ).recoverInlineToolCalls({
        backend: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: null,
        model: 'glm-5:cloud',
        messages: [
          {
            role: 'system',
            content: 'Normal native tool guidance.'
          }
        ],
        content:
          'tool_calls\n[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"how_transformers_actually_work_fact_checked.md\\"}"}}]',
        doneReason: 'stop',
        workspaceRootPath: workspaceRoot,
        workspaceId: null,
        conversationId: 'conversation-json-tool-calls',
        allowAutoToolExecution: true
      });

      expect(result.content).toBe(
        'I read the fact-checked blog draft and can now list the missing sections.'
      );
      expect(result.toolInvocations.map((invocation) => `${invocation.toolId}:${invocation.status}`)).toEqual([
        'read:completed'
      ]);
      expect(result.contextSources.length).toBeGreaterThan(0);
      expect(completeChat).toHaveBeenCalledTimes(1);
    } finally {
      harness.database.close();
    }
  });

  it('does not auto-recover command-only JSON tool_calls output on plain chat turns', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'ollama-desktop-inline-json-tool-calls-plain-chat-')
    );
    tempDirectories.push(directory);
    const workspaceRoot = path.join(directory, 'workspace-root');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, 'README.md'), '# Workspace\n', 'utf8');
    const completeChat = vi.fn();
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-json-tool-calls-plain-chat-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      const result = await (
        harness.service as unknown as {
          recoverInlineToolCalls: (input: {
            backend: 'ollama' | 'nvidia';
            baseUrl: string;
            apiKey: string | null;
            model: string;
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            content: string;
            doneReason: string | null;
            workspaceRootPath: string | null;
            workspaceId: string | null;
            conversationId: string;
            allowAutoToolExecution?: boolean;
          }) => Promise<{
            content: string;
            doneReason: string | null;
            toolInvocations: Array<{ toolId: string; status: string }>;
            contextSources: unknown[];
          }>;
        }
      ).recoverInlineToolCalls({
        backend: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: null,
        model: 'glm-5:cloud',
        messages: [
          {
            role: 'system',
            content: 'Normal tool guidance without a recovery marker.'
          }
        ],
        content:
          'tool_calls\n[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]',
        doneReason: 'stop',
        workspaceRootPath: workspaceRoot,
        workspaceId: null,
        conversationId: 'conversation-json-tool-calls-plain-chat'
      });

      expect(result.content).toContain('tool_calls');
      expect(result.toolInvocations).toHaveLength(0);
      expect(result.contextSources).toHaveLength(0);
      expect(completeChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('recovers plain-text slash commands only in explicit recovery rounds', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-inline-text-command-recovery-'));
    tempDirectories.push(directory);
    const completeChat = vi.fn().mockResolvedValue({
      content: 'Created the tracked task after recovery.',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-inline-text-command-recovery-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      harness.capabilityService.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });

      const result = await (
        harness.service as unknown as {
          recoverInlineToolCalls: (input: {
            backend: 'ollama' | 'nvidia';
            baseUrl: string;
            apiKey: string | null;
            model: string;
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            content: string;
            doneReason: string | null;
            workspaceRootPath: string | null;
            workspaceId: string | null;
            conversationId: string;
            allowAutoToolExecution?: boolean;
          }) => Promise<{
            content: string;
            doneReason: string | null;
            toolInvocations: Array<{ toolId: string; status: string }>;
            contextSources: unknown[];
          }>;
        }
      ).recoverInlineToolCalls({
        backend: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: null,
        model: 'glm-5:cloud',
        messages: [
          {
            role: 'system',
            content: '[bridge-text-command-recovery]\nRetry with the next tool call now.'
          }
        ],
        content: '/task-create {"title":"Ship Milestone 4.1"}',
        doneReason: 'stop',
        workspaceRootPath: null,
        workspaceId: null,
        conversationId: 'conversation-2'
      });

      expect(result.content).toBe('Created the tracked task after recovery.');
      expect(result.toolInvocations.map((invocation) => `${invocation.toolId}:${invocation.status}`)).toEqual([
        'task-create:completed'
      ]);
      expect(harness.capabilityService.listTasks(null)).toHaveLength(1);
      expect(completeChat).toHaveBeenCalledTimes(1);
    } finally {
      harness.database.close();
    }
  });

  it('passes the selected think mode through standard Ollama chat requests', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-think-mode-chat-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        think?: boolean | 'low' | 'medium' | 'high';
        onDelta: (delta: string) => void;
        onThinkingDelta?: (delta: string) => void;
      }) => {
        input.onThinkingDelta?.('Reasoning about the concise answer.');
        input.onDelta('Thinking-enabled reply.');
        return Promise.resolve({
          content: 'Thinking-enabled reply.',
          doneReason: 'stop',
          thinking: 'Reasoning about the concise answer.',
          toolCalls: []
        });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-think-mode-test',
      models: ['llama3.2:latest'],
      streamChat
    });

    try {
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Give me a concise answer.',
          think: 'high'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat.mock.calls[0]?.[0]?.think).toBe('high');
      expect(
        harness.service.listMessages(accepted.conversation.id).at(-1)?.content
      ).toBe(
        '<think>\nReasoning about the concise answer.\n</think>\n\nThinking-enabled reply.'
      );
    } finally {
      harness.database.close();
    }
  });

  it('caps cloud num_ctx by the remaining conversation session budget', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-cloud-num-ctx-'));
    tempDirectories.push(directory);
    const prompt = 'A'.repeat(110_000);
    const streamChat = vi.fn(
      (input: {
        numCtx?: number;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('Budget-aware cloud reply.');
        return Promise.resolve({
          content: 'Budget-aware cloud reply.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const completeChat = vi.fn().mockResolvedValue({
      content:
        '{"toolId":null,"skillId":null,"needsVision":false,"prefersCode":false,"useWorkspaceKnowledge":false,"imageMode":"none","confidence":0.55,"reason":"plain chat"}',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-cloud-num-ctx-test',
      models: ['glm-5:cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Resume the previous conversation.',
        workspaceId: workspace.id
      });
      const seededAssistantMessage = harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Prior cloud reply.',
        attachments: [],
        status: 'completed',
        model: 'glm-5:cloud'
      });

      harness.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: seededAssistantMessage.id,
        routeTrace: {
          strategy: 'chat',
          reason: 'seed',
          confidence: 1,
          selectedModel: 'glm-5:cloud',
          fallbackModel: null,
          activeSkillId: null,
          activeToolId: null,
          usedWorkspacePrompt: false,
          usedPinnedMessages: false,
          usedRag: false,
          usedTools: false
        },
        usage: {
          promptTokens: 500_000,
          completionTokens: 469_995,
          totalTokens: 969_995
        },
        toolInvocations: [],
        contextSources: []
      });

      const accepted = await harness.service.startChatTurn(
        {
          conversationId: conversation.id,
          prompt
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat.mock.calls[0]?.[0]?.numCtx).toBeLessThanOrEqual(30_005);
    } finally {
      harness.database.close();
    }
  });

  it('derives local num_ctx from free RAM and model size instead of using a fixed default', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-local-num-ctx-'));
    tempDirectories.push(directory);
    const prompt = 'B'.repeat(140_000);
    const streamChat = vi.fn(
      (input: {
        numCtx?: number;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('Budget-aware local reply.');
        return Promise.resolve({
          content: 'Budget-aware local reply.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const completeChat = vi.fn().mockResolvedValue({
      content:
        '{"toolId":null,"skillId":null,"needsVision":false,"prefersCode":false,"useWorkspaceKnowledge":false,"imageMode":"none","confidence":0.55,"reason":"plain chat"}',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-local-num-ctx-test',
      modelCatalog: [
        {
          name: 'llama3.2:latest',
          size: 4 * 1024 ** 3,
          digest: null
        }
      ],
      streamChat,
      completeChat,
      readFreeMemoryBytes: () => 12 * 1024 ** 3
    });

    try {
      const accepted = await harness.service.startChatTurn(
        {
          prompt
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat.mock.calls[0]?.[0]?.numCtx).toBe(36_864);
    } finally {
      harness.database.close();
    }
  });

  it('uses the main capability prompt instead of a separate analysis request before native repository turns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-capability-catalog-native-'));
    tempDirectories.push(directory);
    const projectDirectory = path.join(directory, 'sample-project');
    mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
    writeFileSync(path.join(projectDirectory, 'README.md'), '# Sample Project\n', 'utf8');
    writeFileSync(path.join(projectDirectory, 'src', 'index.ts'), 'export const ready = true;\n', 'utf8');
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: '.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Repository summary complete.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-capability-catalog-native-test',
      models: ['glm-5:cloud'],
      completeChat
    });

    try {
      const workspace = await harness.service.createWorkspace({
        name: 'Sample Project',
        rootPath: projectDirectory
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Analyze this repository and create a summary of the implementation.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const firstToolLoopMessages = getMockMessages(completeChat.mock.calls[0]?.[0]);

      expect(
        firstToolLoopMessages.some(
          (message) =>
            message.role === 'system' && message.content.includes('Capability catalog')
        )
      ).toBe(true);
      expect(
        firstToolLoopMessages.some(
          (message) =>
            message.role === 'system' && message.content.includes('Available skills')
        )
      ).toBe(true);
      expect(
        firstToolLoopMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Do not claim you lack access to internal file contents')
        )
      ).toBe(true);
      expect(completeChat).toHaveBeenCalledTimes(2);
    } finally {
      harness.database.close();
    }
  });

  it('uses native workspace tools for repository-analysis prompts when a folder is connected', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-native-workspace-analysis-'));
    tempDirectories.push(directory);
    const projectDirectory = path.join(directory, 'sample-project');
    mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
    writeFileSync(
      path.join(projectDirectory, 'README.md'),
      '# Sample Project\n\nA small test workspace.',
      'utf8'
    );
    writeFileSync(
      path.join(projectDirectory, 'src', 'index.ts'),
      'export function greet(name: string) { return `Hello ${name}`; }\n',
      'utf8'
    );

    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: '.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'src/index.ts'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content:
          'This workspace is a small TypeScript project with a README and a src entrypoint that exports a greet helper.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-native-workspace-analysis-test',
      models: ['glm-5:cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspace = await harness.service.createWorkspace({
        name: 'Sample Project',
        rootPath: projectDirectory
      });
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Analyze this repository and create a summary of the implementation.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const toolLoopMessages = getMockMessages(completeChat.mock.calls[0]?.[0]);

      expect(assistantMessage?.content).toBe(
        'This workspace is a small TypeScript project with a README and a src entrypoint that exports a greet helper.'
      );
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'workspace-lister',
        'read'
      ]);
      expect(
        toolLoopMessages.some(
          (message: { role: string; content: string }) =>
            message.role === 'system' &&
            message.content.includes('Do not claim you lack access to internal file contents')
        )
      ).toBe(true);
      const firstCompleteRequest = completeChat.mock.calls[0]?.[0] as
        | { numCtx?: number }
        | undefined;
      const secondCompleteRequest = completeChat.mock.calls[1]?.[0] as
        | { numCtx?: number }
        | undefined;

      expect(firstCompleteRequest?.numCtx).toBeGreaterThan(0);
      expect(secondCompleteRequest?.numCtx).toBeGreaterThan(0);
      expect(secondCompleteRequest?.numCtx).toBeGreaterThanOrEqual(
        firstCompleteRequest?.numCtx ?? 0
      );
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('treats repository summary file prompts as repository-analysis native tool workflows', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-native-workspace-summary-file-'));
    tempDirectories.push(directory);
    const projectDirectory = path.join(directory, 'screenwriter');
    mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
    writeFileSync(
      path.join(projectDirectory, 'README.md'),
      '# Screenwriter\n\nAn Electron screenplay editor.\n',
      'utf8'
    );
    writeFileSync(
      path.join(projectDirectory, 'package.json'),
      '{\n  "name": "screenwriter",\n  "main": "main.js"\n}\n',
      'utf8'
    );
    writeFileSync(
      path.join(projectDirectory, 'src', 'index.js'),
      'export const boot = () => "ready";\n',
      'utf8'
    );

    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: '.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'README.md'
              }
            }
          },
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'package.json'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: 'src'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'src/index.js'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'src/index.js'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Prepared a grounded repository summary after inspecting the connected workspace files.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-native-workspace-summary-file-test',
      models: ['minimax-m2.7:cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspace = await harness.service.createWorkspace({
        name: 'Screenwriter',
        rootPath: projectDirectory
      });
      const accepted = await harness.service.startChatTurn(
        {
          prompt:
            'Create a summary of this repository and save it as markdown file in same repository with name screenwriter_summary.md (Must contain all the details).',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const toolLoopMessages = getMockMessages(completeChat.mock.calls[0]?.[0]);

      expect(assistantMessage?.content).toBe(
        'Prepared a grounded repository summary after inspecting the connected workspace files.'
      );
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'workspace-lister',
        'read',
        'read',
        'workspace-lister',
        'read',
        'read'
      ]);
      expect(
        toolLoopMessages.some(
          (message: { role: string; content: string }) =>
            message.role === 'system' &&
            message.content.includes('Do not claim you lack access to internal file contents')
        )
      ).toBe(true);
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(6);
    } finally {
      harness.database.close();
    }
  });

  it('passes the selected think mode through native Ollama tool-calling requests', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-think-mode-native-tools-'));
    tempDirectories.push(directory);
    const projectDirectory = path.join(directory, 'sample-project');
    mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
    writeFileSync(path.join(projectDirectory, 'README.md'), '# Sample Project', 'utf8');
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: '.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Repository summary complete.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-think-mode-native-tools-test',
      models: ['gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspace = await harness.service.createWorkspace({
        name: 'Sample Project',
        rootPath: projectDirectory
      });
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Analyze this repository and summarize it.',
          workspaceId: workspace.id,
          think: 'off'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(completeChat).toHaveBeenCalledTimes(2);
      const firstCompleteRequest = completeChat.mock.calls[0]?.[0] as
        | { think?: boolean | 'low' | 'medium' | 'high' }
        | undefined;
      const secondCompleteRequest = completeChat.mock.calls[1]?.[0] as
        | { think?: boolean | 'low' | 'medium' | 'high' }
        | undefined;

      expect(firstCompleteRequest?.think).toBe(false);
      expect(secondCompleteRequest?.think).toBe(false);
      expect(streamChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('exposes the broader capability surface to the native Ollama tool registry', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-native-tool-registry-'));
    tempDirectories.push(directory);
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-native-tool-registry-test',
      models: ['llama3.2:latest']
    });

    try {
      const toolNames = harness.service
        .listTools()
        .map((tool) => tool.id);
      const nativeToolNames = new Set(
        harness.toolDispatcher
          .listOllamaToolDefinitions()
          .map((definition) => definition.function.name)
      );

      expect(toolNames).toContain('task-create');
      expect(nativeToolNames.has('agent')).toBe(true);
      expect(nativeToolNames.has('read')).toBe(true);
      expect(nativeToolNames.has('glob')).toBe(true);
      expect(nativeToolNames.has('grep')).toBe(true);
      expect(nativeToolNames.has('cron-create')).toBe(true);
      expect(nativeToolNames.has('team-create')).toBe(true);
      expect(nativeToolNames.has('todo-write')).toBe(true);
      expect(nativeToolNames.has('skill')).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it('executes native capability tool calls such as task creation before finalizing a chat reply', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-native-capability-tools-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'task-create',
              arguments: {
                title: 'Ship Milestone 4.1',
                details: 'Finish the agentic tool surface.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Created a tracked task for Milestone 4.1.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-native-capability-tool-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      harness.capabilityService.grantPermission({
        capabilityId: 'task-create',
        scopeKind: 'global',
        scopeId: null
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Create a milestone task to track Milestone 4.1 completion.'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe('Created a tracked task for Milestone 4.1.');
      expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('task-create');
      expect(assistantMessage?.toolInvocations?.[0]?.status).toBe('completed');
      expect(harness.capabilityService.listTasks(null)).toHaveLength(1);
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('enables native tool calling for workspace-backed builder turns even when the prompt is short', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-builder-native-tools-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const streamEvents: ChatStreamEvent[] = [];
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'I inspected the existing files and I am ready to apply the sign-up changes.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-builder-native-tool-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<form id="login"></form>', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'script.js'), 'console.log("ready");', 'utf8');
      writeFileSync(path.join(workspaceRoot, 'styles.css'), 'body { color: black; }', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Implement sign-up as well.',
          workspaceId: workspace.id
        },
        (event) => {
          streamEvents.push(event);
        }
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe(
        'I inspected the existing files and I am ready to apply the sign-up changes.'
      );
      expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('read');
      expect(assistantMessage?.toolInvocations?.[0]?.status).toBe('completed');
      expect(assistantMessage?.toolInvocations?.[0]?.outputText).toContain('### Read');
      expect(assistantMessage?.toolInvocations?.[0]?.outputText).toContain(
        '<form id="login"></form>'
      );
      expect(
        streamEvents.some(
          (event) =>
            event.type === 'update' &&
            (event.toolInvocationCount ?? 0) > 0
        )
      ).toBe(true);
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(2);
    } finally {
      harness.database.close();
    }
  });

  it('injects a task-oriented tool reference into native tool guidance', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-tool-reference-guidance-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'I inspected the existing file and identified the current structure.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-tool-reference-guidance-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<form id="login"></form>', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Implement sign-up in the existing page.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const firstNativeToolCallMessages = getMockMessages(completeChat.mock.calls[0]?.[0]);

      expect(
        firstNativeToolCallMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Reading (always call before modifying):')
        )
      ).toBe(true);
      expect(
        firstNativeToolCallMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('`read({filePath})`: read exact file contents.')
        )
      ).toBe(true);
      expect(
        firstNativeToolCallMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes(
              '`write({filePath, content})`: create or fully overwrite a file. Content must be the complete new file, and `write` cannot infer content from a path-only call.'
            )
        )
      ).toBe(true);
    } finally {
      harness.database.close();
    }
  });

  it('keeps plain conversational workspace-backed turns on the direct chat path', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'ollama-desktop-plain-conversation-no-native-tools-')
    );
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('My name is Helix.');
        return Promise.resolve({
          content: 'My name is Helix.',
          doneReason: 'stop',
          thinking: '',
          toolCalls: []
        });
      }
    );
    const completeChat = vi.fn();
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-plain-conversation-no-native-tools-test',
      models: ['glm-5:cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'README.md'), '# Demo workspace\n', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'What is your name?',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const assistantMessage = harness.service.listMessages(accepted.conversation.id).at(-1);

      expect(assistantMessage?.content).toBe('My name is Helix.');
      expect(assistantMessage?.toolInvocations ?? []).toHaveLength(0);
      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(completeChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('uses native tool calling for grounded workspace-inspection turns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-grounded-native-tool-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {
                path: '.'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'blog.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'I reviewed the blog draft and identified missing problem framing, proof points, and a concrete CTA.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-grounded-native-tool-test',
      models: ['glm-5:cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(
        path.join(workspaceRoot, 'blog.md'),
        '# Blog Draft\n\nThe post introduces the feature but does not explain the user pain clearly.\n',
        'utf8'
      );

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: '@grounded identify the gaps in the blog',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const firstNativeToolCallMessages = getMockMessages(completeChat.mock.calls[0]?.[0]);

      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'workspace-lister',
        'read'
      ]);
      expect(assistantMessage?.content).toContain('identified missing problem framing');
      expect(
        firstNativeToolCallMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Available tools') &&
            message.content.includes('never plain-text commands')
        )
      ).toBe(true);
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('retries native tool turns that try to finish before making any tool call', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-missing-tool-call-retry-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'I can handle this from the existing context.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'I inspected the file and identified the current structure.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-missing-tool-call-retry-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<form id="login"></form>', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Implement sign-up in the existing page.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const retryMessages = getMockMessages(completeChat.mock.calls[1]?.[0]);

      expect(assistantMessage?.content).toBe(
        'I inspected the file and identified the current structure.'
      );
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'read'
      ]);
      expect(
        retryMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Do not answer from memory alone.')
        )
      ).toBe(true);
      expect(
        retryMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('Available tools') &&
            message.content.includes('never plain-text commands')
        )
      ).toBe(true);
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      harness.database.close();
    }
  });

  it('keeps file-fix prompts in the native tool loop so the updated file is actually saved', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-file-fix-native-tools-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'screenwriter_summary.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: 'screenwriter_summary.md',
                content:
                  '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed unicode symbols.\n'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'screenwriter_summary.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content:
          'Fixed the corrupted unicode characters in screenwriter_summary.md and saved the updated file.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-file-fix-native-tool-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const summaryPath = path.join(workspaceRoot, 'screenwriter_summary.md');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(
        summaryPath,
        '# Screenwriter - Repository Summary\n\n## ?? Overview\n\nBroken unicode symbols.\n',
        'utf8'
      );

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt:
            'in "screenwriter_summary.md" file please fix the it. it has question marks everywhere probably some missing unicode characters. And save it.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe(
        'Fixed the corrupted unicode characters in screenwriter_summary.md and saved the updated file.'
      );
      expect(assistantMessage?.routeTrace?.activeToolId).toBeNull();
      expect(assistantMessage?.routeTrace?.activeSkillId).toBe('debugger');
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'read',
        'write',
        'read'
      ]);
      expect(readFileSync(summaryPath, 'utf8')).toBe(
        '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed unicode symbols.\n'
      );
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(4);
    } finally {
      harness.database.close();
    }
  });

  it('retries after a recoverable native tool failure instead of accepting a plain-text answer', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-tool-failure-recovery-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'screenwriter_summary.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'edit',
              arguments: {
                filePath: 'screenwriter_summary.md',
                startLine: 99,
                endLine: 99,
                newText: '## Overview'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'I fixed the file.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: 'screenwriter_summary.md',
                content: '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed heading.\n'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'screenwriter_summary.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Fixed the file after retrying with a corrected tool call and verified the result.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-tool-failure-recovery-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const summaryPath = path.join(workspaceRoot, 'screenwriter_summary.md');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(
        summaryPath,
        '# Screenwriter - Repository Summary\n\n## ?? Overview\n\nBroken unicode symbols.\n',
        'utf8'
      );

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Fix the heading in screenwriter_summary.md directly and save it.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const recoveryMessages = getMockMessages(completeChat.mock.calls[3]?.[0]);

      expect(assistantMessage?.content).toBe(
        'Fixed the file after retrying with a corrected tool call and verified the result.'
      );
      expect(
        assistantMessage?.toolInvocations?.map(
          (invocation) => `${invocation.toolId}:${invocation.status}`
        )
      ).toEqual(['read:completed', 'edit:failed', 'write:completed', 'read:completed']);
      expect(readFileSync(summaryPath, 'utf8')).toBe(
        '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed heading.\n'
      );
      expect(
        recoveryMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('The latest tool call failed and the task is not complete.')
        )
      ).toBe(true);
      expect(
        recoveryMessages.some(
          (message) =>
            message.role === 'system' && message.content.includes('Latest failure: `edit`')
        )
      ).toBe(true);
      expect(completeChat).toHaveBeenCalledTimes(6);
    } finally {
      harness.database.close();
    }
  });

  it('escalates follow-up file-reader routes into the native tool loop for file mutations', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'ollama-desktop-file-fix-follow-up-native-tools-')
    );
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: 'screenwriter_summary.md',
                content:
                  '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed unicode symbols after follow-up.\n'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'screenwriter_summary.md'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content:
          'Fixed the unicode corruption in screenwriter_summary.md and saved the changes after the follow-up.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-file-fix-follow-up-native-tool-test',
      models: ['gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const summaryPath = path.join(workspaceRoot, 'screenwriter_summary.md');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(
        summaryPath,
        '# Screenwriter - Repository Summary\n\n## ?? Overview\n\nBroken unicode symbols.\n',
        'utf8'
      );

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const conversation = harness.repository.createConversation({
        prompt: 'Read the repository summary file.',
        workspaceId: workspace.id
      });
      const seededAssistantMessage = harness.repository.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '### File Reader\n\nRead `screenwriter_summary.md`.',
        attachments: [],
        status: 'completed',
        model: 'gemma4:31b-cloud'
      });

      harness.turnMetadataService.saveAssistantTurnArtifacts({
        messageId: seededAssistantMessage.id,
        routeTrace: {
          strategy: 'tool-chat',
          reason: 'file-reader-tool-routing',
          confidence: 0.9,
          selectedModel: 'gemma4:31b-cloud',
          fallbackModel: null,
          activeSkillId: null,
          activeToolId: 'file-reader',
          usedWorkspacePrompt: false,
          usedPinnedMessages: false,
          usedRag: false,
          usedTools: true
        },
        usage: {
          promptTokens: 20,
          completionTokens: 20,
          totalTokens: 40
        },
        toolInvocations: [
          {
            id: '70000000-0000-4000-8000-000000000001',
            toolId: 'file-reader',
            displayName: 'File Reader',
            status: 'completed',
            inputSummary: 'screenwriter_summary.md',
            outputSummary: 'Broken unicode symbols.',
            errorMessage: null,
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z'
          }
        ],
        contextSources: []
      });

      const accepted = await harness.service.startChatTurn(
        {
          conversationId: conversation.id,
          prompt: 'try again and fix the unicode corruption in screenwriter_summary.md directly.'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.routeTrace?.reason).toBe('follow-up-tool-carry-forward');
      expect(assistantMessage?.routeTrace?.activeToolId).toBe('file-reader');
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'file-reader',
        'write',
        'read'
      ]);
      expect(readFileSync(summaryPath, 'utf8')).toBe(
        '# Screenwriter - Repository Summary\n\n## Overview\n\nFixed unicode symbols after follow-up.\n'
      );
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(4);
    } finally {
      harness.database.close();
    }
  });

  it('requires a verification pass before a workspace-backed builder turn can finish after edits', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-builder-verify-loop-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'edit',
              arguments: {
                filePath: 'index.html',
                search: '<form id="login"></form>',
                replacement: '<form id="login"></form>\n<form id="signup"></form>'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Implemented sign-up support.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Implemented sign-up support and verified the updated markup.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-builder-verify-loop-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<form id="login"></form>', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Implement sign-up in the existing page.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const verificationCallMessages = getMockMessages(completeChat.mock.calls[3]?.[0]);

      expect(assistantMessage?.content).toBe(
        'Implemented sign-up support and verified the updated markup.'
      );
      expect(assistantMessage?.toolInvocations?.map((invocation) => invocation.toolId)).toEqual([
        'read',
        'edit',
        'read'
      ]);
      expect(
        verificationCallMessages.some(
          (message: { role: string; content: string }) =>
            message.role === 'system' &&
            message.content.includes('the latest changes have not been verified yet')
        )
      ).toBe(true);
      expect(readFileSync(path.join(workspaceRoot, 'index.html'), 'utf8')).toContain(
        '<form id="signup"></form>'
      );
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(5);
    } finally {
      harness.database.close();
    }
  });

  it('allows a workspace-backed builder turn to keep iterating through edits and verification and still finish cleanly', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-builder-tool-rounds-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'workspace-lister',
              arguments: {}
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'index.html'
              }
            }
          },
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'script.js'
              }
            }
          },
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'styles.css'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'edit',
              arguments: {
                filePath: 'index.html',
                search: '<p class="signup-link">Sign up</p>',
                replacement:
                  '<div class="auth-tabs"><button>Sign In</button><button>Sign Up</button></div>\n<p class="signup-link">Sign up</p>'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'edit',
              arguments: {
                filePath: 'script.js',
                search: 'function handleLogin() {\n  return true;\n}\n',
                replacement:
                  'function handleLogin() {\n  return true;\n}\n\nfunction handleSignup() {\n  return true;\n}\n'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Implemented the sign-up UI entry points after inspecting and updating the existing files.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                path: 'script.js'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content:
          'Implemented the sign-up UI entry points after inspecting, updating, and verifying the existing files.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-builder-round-limit-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(
        path.join(workspaceRoot, 'index.html'),
        [
          '<!DOCTYPE html>',
          '<html>',
          '<body>',
          '<div class="login-box">',
          '<form id="loginForm"></form>',
          '<p class="signup-link">Sign up</p>',
          '</div>',
          '</body>',
          '</html>'
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        path.join(workspaceRoot, 'script.js'),
        ['function handleLogin() {', '  return true;', '}', ''].join('\n'),
        'utf8'
      );
      writeFileSync(path.join(workspaceRoot, 'styles.css'), '.login-box { display: block; }\n', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'edit',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Read existing files and implement sign-up functionality in existing code.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe(
        'Implemented the sign-up UI entry points after inspecting, updating, and verifying the existing files.'
      );
      expect(assistantMessage?.toolInvocations).toHaveLength(7);
      expect(streamChat).not.toHaveBeenCalled();
      expect(completeChat).toHaveBeenCalledTimes(7);
      expect(readFileSync(path.join(workspaceRoot, 'index.html'), 'utf8')).toContain(
        '<div class="auth-tabs"><button>Sign In</button><button>Sign Up</button></div>'
      );
      expect(readFileSync(path.join(workspaceRoot, 'script.js'), 'utf8')).toContain(
        'function handleSignup()'
      );
    } finally {
      harness.database.close();
    }
  });

  it('extends the coding round budget when a workspace-backed builder turn keeps making tool progress', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-builder-round-extension-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi.fn();
    const scaffoldRoundCount = 13;

    for (let index = 1; index <= scaffoldRoundCount; index += 1) {
      completeChat.mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: `scaffold/file-${index}.txt`,
                content: `scaffold file ${index}\n`
              }
            }
          }
        ]
      });
    }

    completeChat
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'scaffold/file-13.txt'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Created and verified the scaffold files.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });

    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-builder-round-extension-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Create the initial scaffold files for this project and verify the result.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe('Created and verified the scaffold files.');
      expect(assistantMessage?.toolInvocations).toHaveLength(scaffoldRoundCount + 1);
      expect(completeChat).toHaveBeenCalledTimes(scaffoldRoundCount + 2);
      expect(streamChat).not.toHaveBeenCalled();
      expect(readFileSync(path.join(workspaceRoot, 'scaffold', 'file-1.txt'), 'utf8')).toBe(
        'scaffold file 1\n'
      );
      expect(readFileSync(path.join(workspaceRoot, 'scaffold', 'file-13.txt'), 'utf8')).toBe(
        'scaffold file 13\n'
      );
    } finally {
      harness.database.close();
    }
  });

  it('streams native tool-loop assistant text for local workspace-backed coding turns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-local-native-stream-'));
    tempDirectories.push(directory);
    const streamEvents: ChatStreamEvent[] = [];
    const streamChat = vi
      .fn()
      .mockImplementationOnce(
        (input: {
          onDelta: (delta: string) => void;
          onThinkingDelta?: (delta: string) => void;
        }) => {
          input.onThinkingDelta?.('Planning the read step.');
          input.onDelta('Inspecting the existing page before editing.');

          return Promise.resolve({
            content: 'Inspecting the existing page before editing.',
            doneReason: 'stop',
            thinking: 'Planning the read step.',
            toolCalls: [
              {
                type: 'function' as const,
                function: {
                  name: 'read',
                  arguments: {
                    path: 'index.html'
                  }
                }
              }
            ]
          });
        }
      )
      .mockImplementationOnce(
        (input: {
          onDelta: (delta: string) => void;
          onThinkingDelta?: (delta: string) => void;
        }) => {
          input.onThinkingDelta?.('Summarizing the verified result.');
          input.onDelta('Implemented sign-up support and verified the result.');

          return Promise.resolve({
            content: 'Implemented sign-up support and verified the result.',
            doneReason: 'stop',
            thinking: 'Summarizing the verified result.',
            toolCalls: []
          });
        }
      );
    const completeChat = vi.fn().mockResolvedValueOnce({
      content: '',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-local-native-stream-test',
      models: ['llama3.2:latest'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'index.html'), '<form id="login"></form>', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Implement sign-up in the existing page.',
          workspaceId: workspace.id
        },
        (event) => {
          streamEvents.push(event);
        }
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      const assistantMessage = assistantMessages.at(-1);

      expect(
        streamEvents.some(
          (event) =>
            event.type === 'update' &&
            event.content.includes('Inspecting the existing page before editing.')
        )
      ).toBe(true);
      expect(
        streamEvents.some((event) => event.type === 'message-created')
      ).toBe(true);
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0]?.content).toContain('<think>');
      expect(assistantMessages[0]?.content).toContain('Planning the read step.');
      expect(assistantMessages[0]?.content).toContain(
        'Inspecting the existing page before editing.'
      );
      expect(assistantMessage?.content).toBe(
        '<think>\nSummarizing the verified result.\n</think>\n\nImplemented sign-up support and verified the result.'
      );
      expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('read');
      expect(streamChat).toHaveBeenCalledTimes(2);
      expect(completeChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('keeps local native tool turns alive when a rich progress event payload is rejected once', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-local-progress-fallback-'));
    tempDirectories.push(directory);
    const streamEvents: ChatStreamEvent[] = [];
    const streamChat = vi
      .fn()
      .mockImplementationOnce(
        (input: {
          onDelta: (delta: string) => void;
        }) => {
          input.onDelta('Inspecting settings before editing.');

          return Promise.resolve({
            content: 'Inspecting settings before editing.',
            doneReason: 'stop',
            thinking: '',
            toolCalls: [
              {
                type: 'function' as const,
                function: {
                  name: 'read',
                  arguments: {
                    path: 'config.py'
                  }
                }
              }
            ]
          });
        }
      )
      .mockImplementationOnce(
        (input: {
          onDelta: (delta: string) => void;
        }) => {
          input.onDelta('Updated the settings flow and verified the existing configuration.');

          return Promise.resolve({
            content: 'Updated the settings flow and verified the existing configuration.',
            doneReason: 'stop',
            thinking: '',
            toolCalls: []
          });
        }
      );
    const completeChat = vi.fn().mockResolvedValueOnce({
      content: '',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-local-progress-fallback-test',
      models: ['llama3.2:latest'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'config.py'), 'class Settings:\n    pass\n', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      let rejectedRichUpdate = false;
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Update the settings flow in the existing project.',
          workspaceId: workspace.id
        },
        (event) => {
          if (
            !rejectedRichUpdate &&
            event.type === 'update' &&
            (event.contextSourceCount ?? 0) > 0
          ) {
            rejectedRichUpdate = true;
            throw new Error('Renderer rejected a rich progress payload');
          }

          streamEvents.push(event);
        }
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(rejectedRichUpdate).toBe(true);
      expect(assistantMessage?.content).toBe(
        'Updated the settings flow and verified the existing configuration.'
      );
      expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('read');
      expect(
        streamEvents.some(
          (event) =>
            event.type === 'complete' &&
            event.content === 'Updated the settings flow and verified the existing configuration.'
        )
      ).toBe(true);
      expect(streamChat).toHaveBeenCalledTimes(2);
      expect(completeChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('allows local workspace-backed coding turns to extend well past the prior hard round cap', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-local-round-budget-'));
    tempDirectories.push(directory);
    const scaffoldRoundCount = 33;
    let nativeRound = 0;
    const streamChat = vi.fn().mockImplementation(() => {
      nativeRound += 1;

      if (nativeRound <= scaffoldRoundCount) {
        return Promise.resolve({
          content: '',
          doneReason: 'stop',
          thinking: '',
          toolCalls: [
            {
              type: 'function' as const,
              function: {
                name: 'write',
                arguments: {
                  filePath: `scaffold/file-${nativeRound}.txt`,
                  content: `scaffold file ${nativeRound}\n`
                }
              }
            }
          ]
        });
      }

      if (nativeRound === scaffoldRoundCount + 1) {
        return Promise.resolve({
          content: '',
          doneReason: 'stop',
          thinking: '',
          toolCalls: [
            {
              type: 'function' as const,
              function: {
                name: 'read',
                arguments: {
                  filePath: `scaffold/file-${scaffoldRoundCount}.txt`
                }
              }
            }
          ]
        });
      }

      return Promise.resolve({
        content: 'Created and verified the local scaffold files.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    });
    const completeChat = vi.fn().mockResolvedValueOnce({
      content: '',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-local-round-budget-test',
      models: ['llama3.2:latest'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Create the initial scaffold files for this project and verify the result.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toBe('Created and verified the local scaffold files.');
      expect(assistantMessage?.toolInvocations).toHaveLength(scaffoldRoundCount + 1);
      expect(streamChat).toHaveBeenCalledTimes(scaffoldRoundCount + 2);
      expect(completeChat).not.toHaveBeenCalled();
      expect(
        readFileSync(path.join(workspaceRoot, 'scaffold', `file-${scaffoldRoundCount}.txt`), 'utf8')
      ).toBe(`scaffold file ${scaffoldRoundCount}\n`);
    } finally {
      harness.database.close();
    }
  });

  it('keeps file-oriented wireframe prompts in preview mode instead of workspace writes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-wireframe-no-write-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        onDelta: (delta: string) => void;
      }) => {
        const content =
          '```wireframe\n' +
          '{"type":"design","title":"Saved Prompt Preview","html":"<main><section class=\\"phone-screen\\">Preview</section></main>","css":".phone-screen { background: #101827; color: white; }","js":""}\n' +
          '```';
        input.onDelta(content);

        return Promise.resolve({
          content,
          doneReason: 'stop',
          thinking: '',
          toolCalls: [
            {
              type: 'function' as const,
              function: {
                name: 'write',
                arguments: {
                  filePath: 'index.html',
                  content: '<!doctype html><html><body>Wrong surface</body></html>'
                }
              }
            }
          ]
        });
      }
    );
    const completeChat = vi.fn().mockResolvedValue({
      content: '',
      doneReason: 'stop',
      thinking: '',
      toolCalls: []
    });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-wireframe-no-workspace-write-test',
      models: ['llama3.2:latest'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const indexPath = path.join(workspaceRoot, 'index.html');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Create index.html for this music app wireframe and save it.',
          workspaceId: workspace.id,
          mode: 'wireframe'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.content).toContain('"type":"design"');
      expect(assistantMessage?.content).toContain('phone-screen');
      expect(assistantMessage?.toolInvocations ?? []).toHaveLength(0);
      expect(existsSync(indexPath)).toBe(false);
      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(completeChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('retries wireframe turns that complete with only thinking content', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-wireframe-thinking-only-'));
    tempDirectories.push(directory);
    const streamChat = vi
      .fn()
      .mockImplementationOnce(
        (input: {
          think?: boolean | 'low' | 'medium' | 'high';
          onThinkingDelta?: (delta: string) => void;
        }) => {
          input.onThinkingDelta?.('garbled hidden reasoning');

          return Promise.resolve({
            content: '',
            doneReason: 'stop',
            thinking: 'garbled hidden reasoning',
            toolCalls: []
          });
        }
      )
      .mockImplementationOnce(
        (input: {
          think?: boolean | 'low' | 'medium' | 'high';
          messages: Array<{ role: string; content: string }>;
          onDelta: (delta: string) => void;
          onThinkingDelta?: (delta: string) => void;
        }) => {
          const content =
            '```wireframe\n' +
            '{"type":"questions","questions":[{"id":"scope","label":"Which screen should be most detailed?","selection":"single","options":[{"id":"A","label":"Home"},{"id":"B","label":"Search"}]}]}\n' +
            '```';
          input.onThinkingDelta?.('retry reasoning should be ignored');
          input.onDelta(content);

          return Promise.resolve({
            content,
            doneReason: 'stop',
            thinking: 'retry reasoning should be ignored',
            toolCalls: []
          });
        }
      );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-wireframe-thinking-only-retry-test',
      models: ['llama3.2:latest'],
      streamChat
    });

    try {
      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Design a music app wireframe.',
          mode: 'wireframe',
          think: 'high'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(streamChat).toHaveBeenCalledTimes(2);
      expect(streamChat.mock.calls[0]?.[0]?.think).toBe(false);
      expect(streamChat.mock.calls[1]?.[0]?.think).toBe(false);
      expect(getMockMessages(streamChat.mock.calls[1]?.[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Wireframe mode recovery')
          })
        ])
      );
      expect(assistantMessage?.content).toContain('"type":"questions"');
      expect(assistantMessage?.content).not.toContain('<think>');
      expect(assistantMessage?.content).not.toContain('garbled hidden reasoning');
    } finally {
      harness.database.close();
    }
  });

  it('reuses the prior tool input when a follow-up turn carries a tool forward', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-tool-follow-up-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('Tool-assisted answer.');
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-tool-follow-up-test',
      models: ['glm-4.7-flash:latest'],
      streamChat
    });

    try {
      const firstAccepted = await harness.service.startChatTurn(
        {
          prompt: 'What is 2 + 4?'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(firstAccepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const secondAccepted = await harness.service.startChatTurn(
        {
          conversationId: firstAccepted.conversation.id,
          prompt: 'try again'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(firstAccepted.conversation.id);
        expect(messages.at(-1)?.id).toBe(secondAccepted.assistantMessage.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(firstAccepted.conversation.id);
      const followUpUserMessage = messages.at(-2);
      const followUpAssistantMessage = messages.at(-1);

      expect(followUpUserMessage?.role).toBe('user');
      expect(followUpUserMessage?.content).toBe('try again');
      expect(followUpAssistantMessage?.role).toBe('assistant');
      expect(followUpAssistantMessage?.routeTrace?.reason).toBe('follow-up-tool-carry-forward');
      expect(followUpAssistantMessage?.toolInvocations).toHaveLength(1);
      expect(followUpAssistantMessage?.toolInvocations?.[0]?.status).toBe('completed');
      expect(followUpAssistantMessage?.toolInvocations?.[0]?.inputSummary).toBe('2 + 4');
      expect(streamChat).toHaveBeenCalledTimes(2);
    } finally {
      harness.database.close();
    }
  });

  it('recovers from a path-only write tool call by demanding full file content', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-write-recovery-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: {
                filePath: 'index.html',
                content: '<!doctype html>\n<html><body><h1>Browser OS</h1></body></html>\n'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        doneReason: 'stop',
        thinking: '',
        toolCalls: [
          {
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: {
                filePath: 'index.html'
              }
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        content: 'Created index.html after retrying with a complete write payload and verified it.',
        doneReason: 'stop',
        thinking: '',
        toolCalls: []
      });
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-write-tool-recovery-test',
      models: ['glm-5:cloud', 'gemma4:31b-cloud'],
      streamChat,
      completeChat
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const indexPath = path.join(workspaceRoot, 'index.html');
      mkdirSync(workspaceRoot, { recursive: true });

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);
      harness.capabilityService.grantPermission({
        capabilityId: 'write',
        scopeKind: 'workspace',
        scopeId: workspace.id
      });

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'Create index.html for a simple browser app shell and save it.',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);
      const recoveryMessages = getMockMessages(completeChat.mock.calls[1]?.[0]);

      expect(assistantMessage?.content).toBe(
        'Created index.html after retrying with a complete write payload and verified it.'
      );
      expect(
        assistantMessage?.toolInvocations?.map(
          (invocation) => `${invocation.toolId}:${invocation.status}`
        )
      ).toEqual(['write:failed', 'write:completed', 'read:completed']);
      expect(readFileSync(indexPath, 'utf8')).toBe(
        '<!doctype html>\n<html><body><h1>Browser OS</h1></body></html>\n'
      );
      expect(
        recoveryMessages.some(
          (message) =>
            message.role === 'tool' &&
            message.content.includes('Failed arguments: {"filePath":"index.html"}')
        )
      ).toBe(true);
      expect(
        recoveryMessages.some(
          (message) =>
            message.role === 'tool' &&
            message.content.includes(
              '`write` is a single-call file creation or overwrite tool. It cannot infer file contents from `filePath` alone.'
            )
        )
      ).toBe(true);
      expect(completeChat).toHaveBeenCalledTimes(4);
    } finally {
      harness.database.close();
    }
  });

  it('keeps natural-language directory prompts in plain chat when no workspace folder is connected', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-rootless-workspace-listing-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        input.onDelta('I need a connected workspace folder before I can inspect local files.');
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-rootless-workspace-listing-test',
      models: ['glm-4.7-flash:latest'],
      streamChat
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'List all the files in this directory',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        const assistantMessage = messages.at(-1);

        expect(assistantMessage?.status).toBe('completed');
        expect(assistantMessage?.toolInvocations ?? []).toHaveLength(0);
      });

      const messages = harness.service.listMessages(accepted.conversation.id);
      const assistantMessage = messages.at(-1);

      expect(assistantMessage?.routeTrace?.activeToolId).toBeNull();
      expect(assistantMessage?.content).toContain('connected workspace folder');
      expect(streamChat).toHaveBeenCalledTimes(1);
    } finally {
      harness.database.close();
    }
  });

  it('handles play/open prompts as direct workspace opener tool turns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-workspace-open-'));
    tempDirectories.push(directory);
    const streamChat = vi.fn();
    const openWorkspacePath = vi
      .fn<WorkspacePathLauncher>()
      .mockResolvedValue('');
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-workspace-open-test',
      models: ['glm-4.7-flash:latest'],
      streamChat,
      openWorkspacePath
    });

    try {
      const workspaceRoot = path.join(directory, 'workspace-root');
      const videoPath = path.join(workspaceRoot, 'TWICE_Hare_Hare_Music_Video.mp4');
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(videoPath, 'video', 'utf8');

      const workspace = harness.repository.ensureDefaultWorkspace();
      harness.repository.updateWorkspaceRoot(workspace.id, workspaceRoot);

      const accepted = await harness.service.startChatTurn(
        {
          prompt: 'play TWICE_Hare_Hare_Music_Video.mp4',
          workspaceId: workspace.id
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        const assistantMessage = messages.at(-1);

        expect(assistantMessage?.status).toBe('completed');
        expect(assistantMessage?.routeTrace?.reason).toBe('workspace-opener-tool-routing');
        expect(assistantMessage?.toolInvocations?.[0]?.status).toBe('completed');
        expect(assistantMessage?.toolInvocations?.[0]?.toolId).toBe('workspace-opener');
        expect(assistantMessage?.toolInvocations?.[0]?.inputSummary).toBe(
          'TWICE_Hare_Hare_Music_Video.mp4'
        );
      });

      expect(openWorkspacePath).toHaveBeenCalledWith(videoPath);
      expect(streamChat).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it('injects summarized conversation memory while pruning older raw turns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-memory-context-'));
    tempDirectories.push(directory);

    let capturedMessages:
      | Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>
      | undefined;
    const streamChat = vi.fn(
      (input: {
        baseUrl: string;
        model: string;
        messages: Array<{
          role: 'system' | 'user' | 'assistant';
          content: string;
          images?: string[];
        }>;
        onDelta: (delta: string) => void;
      }) => {
        capturedMessages = input.messages;
        input.onDelta('Summaries are active.');
        return Promise.resolve({ doneReason: 'stop' });
      }
    );
    const harness = createChatServiceHarness({
      directory,
      loggerName: 'chat-memory-context-test',
      models: ['glm-4.7-flash:latest'],
      streamChat
    });

    try {
      const workspace = harness.repository.ensureDefaultWorkspace();
      const conversation = harness.repository.createConversation({
        prompt: 'Memory context test',
        workspaceId: workspace.id
      });

      for (let index = 0; index < 10; index += 1) {
        harness.repository.createMessage({
          conversationId: conversation.id,
          role: 'user',
          content: `Older user turn ${index + 1}`,
          status: 'completed'
        });
        harness.repository.createMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: `Older assistant turn ${index + 1}`,
          status: 'completed'
        });
      }

      const accepted = await harness.service.startChatTurn(
        {
          conversationId: conversation.id,
          prompt: 'Give me the next step.'
        },
        () => undefined
      );

      await vi.waitFor(() => {
        const messages = harness.service.listMessages(accepted.conversation.id);
        expect(messages.at(-1)?.status).toBe('completed');
      });

      expect(capturedMessages?.some((message) =>
        message.role === 'system' &&
        message.content.includes('Summarized conversation memory')
      )).toBe(true);
      expect(capturedMessages?.filter((message) => message.role !== 'system').length).toBeLessThan(
        22
      );
    } finally {
      harness.database.close();
    }
  });
});
