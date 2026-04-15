import { create } from 'zustand';
import type {
  AgentSession,
  AuditEventRecord,
  ChatTurnAccepted,
  ChatStreamEvent,
  CapabilityPermission,
  CapabilityTask,
  ConversationSearchResult,
  ConversationSummary,
  GenerationJob,
  GenerationStreamEvent,
  ImageGenerationModelCatalog,
  ImageGenerationRequest,
  KnowledgeDocument,
  MessageAttachment,
  OllamaThinkMode,
  PlanState,
  ScheduledPrompt,
  SkillDefinition,
  StoredMessage,
  SystemStatus,
  TeamSession,
  ToolDefinition,
  UpdateUserSettings,
  UserSettings,
  WorktreeSession,
  WorkspaceSummary
} from '@bridge/ipc/contracts';
import { getDesktopApi } from '@renderer/lib/api';

let latestSearchRequest = 0;

function sortConversations(conversations: ConversationSummary[]) {
  return [...conversations].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function upsertConversation(
  existing: ConversationSummary[],
  nextConversation: ConversationSummary
) {
  const withoutExisting = existing.filter(
    (conversation) => conversation.id !== nextConversation.id
  );

  return sortConversations([nextConversation, ...withoutExisting]);
}

function upsertWorkspace(existing: WorkspaceSummary[], nextWorkspace: WorkspaceSummary) {
  const withoutExisting = existing.filter((workspace) => workspace.id !== nextWorkspace.id);

  return [...withoutExisting, nextWorkspace].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function upsertGenerationJobList(existing: GenerationJob[], nextJob: GenerationJob) {
  return [nextJob, ...existing.filter((job) => job.id !== nextJob.id)].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

type ChatThinkModeSelection = '' | OllamaThinkMode;

function normalizeThinkModeSelection(
  selectedThinkMode: ChatThinkModeSelection
): OllamaThinkMode | undefined {
  return selectedThinkMode || undefined;
}

interface AssistantMessageUpdateResult {
  found: boolean;
  messagesByConversation: Record<string, StoredMessage[]>;
}

function updateAssistantMessage(
  messagesByConversation: Record<string, StoredMessage[]>,
  assistantMessageId: string,
  updater: (message: StoredMessage) => StoredMessage
): AssistantMessageUpdateResult {
  for (const [conversationId, messages] of Object.entries(messagesByConversation)) {
    const index = messages.findIndex((message) => message.id === assistantMessageId);

    if (index === -1) {
      continue;
    }

    const nextMessages = [...messages];
    const currentMessage = nextMessages[index];

    if (!currentMessage) {
      return {
        found: false,
        messagesByConversation
      };
    }

    nextMessages[index] = updater(currentMessage);

    return {
      found: true,
      messagesByConversation: {
        ...messagesByConversation,
        [conversationId]: nextMessages
      }
    };
  }

  return {
    found: false,
    messagesByConversation
  };
}

function upsertStreamingAssistantId(
  streamingAssistantIds: string[],
  assistantMessageId: string
) {
  return streamingAssistantIds.includes(assistantMessageId)
    ? streamingAssistantIds
    : [...streamingAssistantIds, assistantMessageId];
}

function removePendingStreamEvent(
  pendingStreamEventsByAssistantId: Record<string, ChatStreamEvent>,
  assistantMessageId: string
) {
  if (!(assistantMessageId in pendingStreamEventsByAssistantId)) {
    return pendingStreamEventsByAssistantId;
  }

  const nextPendingEvents = { ...pendingStreamEventsByAssistantId };
  delete nextPendingEvents[assistantMessageId];
  return nextPendingEvents;
}

function isTerminalStreamEvent(event: ChatStreamEvent) {
  return event.type === 'complete' || event.type === 'error';
}

const PLAN_TASK_TOOL_IDS = new Set([
  'enter-plan-mode',
  'exit-plan-mode',
  'task-create',
  'task-update',
  'task-stop',
  'todo-write'
]);

function hasPlanTaskToolInvocation(event: ChatStreamEvent): boolean {
  if (event.type !== 'update') return false;
  return (event.toolInvocations ?? []).some((inv) => PLAN_TASK_TOOL_IDS.has(inv.toolId));
}

function applyAssistantStreamSnapshot(
  message: StoredMessage,
  snapshot: {
    content: string;
    status: StoredMessage['status'];
    model?: StoredMessage['model'];
    toolInvocations?: StoredMessage['toolInvocations'];
    contextSources?: StoredMessage['contextSources'];
    usage?: StoredMessage['usage'];
    routeTrace?: StoredMessage['routeTrace'];
  }
): StoredMessage {
  return {
    ...message,
    content: snapshot.content,
    status: snapshot.status,
    model: snapshot.model === undefined ? message.model : snapshot.model,
    toolInvocations:
      snapshot.toolInvocations === undefined
        ? message.toolInvocations
        : snapshot.toolInvocations,
    contextSources:
      snapshot.contextSources === undefined
        ? message.contextSources
        : snapshot.contextSources,
    usage: snapshot.usage === undefined ? message.usage : snapshot.usage,
    routeTrace:
      snapshot.routeTrace === undefined ? message.routeTrace : snapshot.routeTrace,
    updatedAt: new Date().toISOString()
  };
}

function applyStreamEventToMessages(
  messagesByConversation: Record<string, StoredMessage[]>,
  event: ChatStreamEvent
): AssistantMessageUpdateResult {
  if (event.type === 'delta') {
    return updateAssistantMessage(messagesByConversation, event.assistantMessageId, (message) =>
      applyAssistantStreamSnapshot(message, {
        content: event.content,
        status: 'streaming'
      })
    );
  }

  if (event.type === 'update') {
    return updateAssistantMessage(messagesByConversation, event.assistantMessageId, (message) =>
      applyAssistantStreamSnapshot(message, {
        content: event.content,
        status: event.status,
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.toolInvocations === undefined
          ? {}
          : { toolInvocations: event.toolInvocations }),
        ...(event.contextSources === undefined
          ? {}
          : { contextSources: event.contextSources }),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.routeTrace === undefined ? {} : { routeTrace: event.routeTrace })
      })
    );
  }

  if (event.type === 'complete') {
    return updateAssistantMessage(messagesByConversation, event.assistantMessageId, (message) =>
      applyAssistantStreamSnapshot(message, {
        content: event.content,
        status: 'completed',
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.toolInvocations === undefined
          ? {}
          : { toolInvocations: event.toolInvocations }),
        ...(event.contextSources === undefined
          ? {}
          : { contextSources: event.contextSources }),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.routeTrace === undefined ? {} : { routeTrace: event.routeTrace })
      })
    );
  }

  return updateAssistantMessage(messagesByConversation, event.assistantMessageId, (message) => ({
    ...message,
    status: 'failed',
    updatedAt: new Date().toISOString()
  }));
}

function integrateAcceptedTurn(
  state: AppStoreState,
  accepted: ChatTurnAccepted,
  messages: StoredMessage[]
) {
  const pendingEvent = state.pendingStreamEventsByAssistantId[accepted.assistantMessage.id];
  const appliedPendingEvent =
    pendingEvent === undefined
      ? {
          found: false,
          messagesByConversation: {
            ...state.messagesByConversation,
            [accepted.conversation.id]: messages
          }
        }
      : applyStreamEventToMessages(
          {
            ...state.messagesByConversation,
            [accepted.conversation.id]: messages
          },
          pendingEvent
        );
  const bufferedTerminalEvent = pendingEvent ? isTerminalStreamEvent(pendingEvent) : false;

  return {
    activeConversationId: accepted.conversation.id,
    activeWorkspaceId: accepted.conversation.workspaceId ?? state.activeWorkspaceId,
    conversations: upsertConversation(state.conversations, accepted.conversation),
    messagesByConversation: appliedPendingEvent.messagesByConversation,
    streamingAssistantIds: bufferedTerminalEvent
      ? state.streamingAssistantIds.filter((id) => id !== accepted.assistantMessage.id)
      : upsertStreamingAssistantId(
          state.streamingAssistantIds,
          accepted.assistantMessage.id
        ),
    pendingStreamEventsByAssistantId: removePendingStreamEvent(
      state.pendingStreamEventsByAssistantId,
      accepted.assistantMessage.id
    ),
    lastImportPath: null,
    systemStatus: state.systemStatus
      ? {
          ...state.systemStatus,
          pendingRequestCount: bufferedTerminalEvent
            ? state.systemStatus.pendingRequestCount
            : state.systemStatus.pendingRequestCount + 1
        }
      : state.systemStatus
  };
}

function getFirstConversationIdForWorkspace(
  conversations: ConversationSummary[],
  workspaceId: string | null
) {
  return (
    sortConversations(conversations).find((conversation) =>
      workspaceId === null ? true : conversation.workspaceId === workspaceId
    )?.id ?? null
  );
}

function findConversationIdByAssistantMessage(
  messagesByConversation: Record<string, StoredMessage[]>,
  assistantMessageId: string
) {
  return (
    Object.entries(messagesByConversation).find(([, messages]) =>
      messages.some((message) => message.id === assistantMessageId)
    )?.[0] ?? null
  );
}

interface AppStoreState {
  initialized: boolean;
  bootstrapError: string | null;
  settings: UserSettings | null;
  systemStatus: SystemStatus | null;
  workspaces: WorkspaceSummary[];
  conversations: ConversationSummary[];
  generationJobs: GenerationJob[];
  imageGenerationModelCatalog: ImageGenerationModelCatalog | null;
  availableTools: ToolDefinition[];
  availableSkills: SkillDefinition[];
  capabilityPermissions: CapabilityPermission[];
  capabilityTasks: CapabilityTask[];
  capabilitySchedules: ScheduledPrompt[];
  capabilityAgents: AgentSession[];
  capabilityTeams: TeamSession[];
  capabilityWorktrees: WorktreeSession[];
  capabilityPlanState: PlanState | null;
  capabilityAuditEvents: AuditEventRecord[];
  knowledgeDocumentsByWorkspace: Record<string, KnowledgeDocument[]>;
  searchQuery: string;
  searchResults: ConversationSearchResult[];
  activeWorkspaceId: string | null;
  activeConversationId: string | null;
  messagesByConversation: Record<string, StoredMessage[]>;
  selectedModel: string;
  selectedThinkMode: ChatThinkModeSelection;
  settingsDrawerOpen: boolean;
  queueDrawerOpen: boolean;
  planDrawerOpen: boolean;
  streamingAssistantIds: string[];
  pendingStreamEventsByAssistantId: Record<string, ChatStreamEvent>;
  lastExportPath: string | null;
  lastImportPath: string | null;
  loadInitialData: () => Promise<void>;
  refreshGenerationJobs: () => Promise<void>;
  inspectImageGenerationModels: (
    additionalModelsDirectory?: string | null
  ) => Promise<ImageGenerationModelCatalog>;
  refreshCapabilitySurface: () => Promise<void>;
  refreshSystemStatus: () => Promise<void>;
  rehydrateConversationMessages: (conversationId: string) => Promise<void>;
  refreshWorkspaceKnowledge: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string | null) => Promise<void>;
  createWorkspace: (input: { name: string; rootPath?: string }) => Promise<void>;
  pickWorkspaceDirectory: () => Promise<string | null>;
  updateWorkspaceRoot: (workspaceId: string, rootPath: string | null) => Promise<void>;
  setSearchQuery: (query: string) => Promise<void>;
  clearSearch: () => void;
  selectConversation: (conversationId: string | null) => Promise<void>;
  toggleSettingsDrawer: (open?: boolean) => void;
  toggleQueueDrawer: (open?: boolean) => void;
  togglePlanDrawer: (open?: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSelectedThinkMode: (thinkMode: ChatThinkModeSelection) => void;
  updateSettings: (patch: UpdateUserSettings) => Promise<void>;
  grantCapabilityPermission: (capabilityId: string) => Promise<void>;
  revokeCapabilityPermission: (capabilityId: string) => Promise<void>;
  startImageGeneration: (
    input: ImageGenerationRequest
  ) => Promise<void>;
  sendPrompt: (prompt: string, attachments?: MessageAttachment[]) => Promise<void>;
  editMessageAndResend: (
    messageId: string,
    prompt: string,
    attachments?: MessageAttachment[]
  ) => Promise<void>;
  regenerateResponse: (assistantMessageId: string) => Promise<void>;
  cancelChatTurn: (assistantMessageId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  pinMessage: (messageId: string, pinned: boolean) => Promise<void>;
  importWorkspaceKnowledge: () => Promise<void>;
  importConversation: () => Promise<void>;
  exportActiveConversation: (format?: 'markdown' | 'json') => Promise<void>;
  applyStreamEvent: (event: ChatStreamEvent) => void;
  applyGenerationEvent: (event: GenerationStreamEvent) => void;
  cancelGenerationJob: (jobId: string) => Promise<void>;
  retryGenerationJob: (jobId: string) => Promise<void>;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
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
  activeWorkspaceId: null,
  activeConversationId: null,
  messagesByConversation: {},
  selectedModel: '',
  selectedThinkMode: '',
  settingsDrawerOpen: false,
  queueDrawerOpen: false,
  planDrawerOpen: false,
  streamingAssistantIds: [],
  pendingStreamEventsByAssistantId: {},
  lastExportPath: null,
  lastImportPath: null,

  loadInitialData: async () => {
    const api = getDesktopApi();

    try {
      const settings = await api.settings.get();
      const [
        systemStatus,
        workspaces,
        conversations,
        generationJobs,
        imageGenerationModelCatalog,
        availableTools,
        availableSkills,
        capabilityPermissions,
        capabilityTasks,
        capabilitySchedules,
        capabilityAgents,
        capabilityTeams,
        capabilityWorktrees,
        capabilityPlanState,
        capabilityAuditEvents
      ] =
        await Promise.all([
          api.system.getStatus(),
          api.chat.listWorkspaces(),
          api.chat.listConversations(),
          api.generation.listJobs(),
          api.generation.listImageModels({
            additionalModelsDirectory: settings.additionalModelsDirectory
          }),
          api.chat.listTools(),
          api.chat.listSkills(),
          api.capabilities.listPermissions(),
          api.capabilities.listTasks(),
          api.capabilities.listSchedules(),
          api.capabilities.listAgents(),
          api.capabilities.listTeams(),
          api.capabilities.listWorktrees(),
          api.capabilities.getPlanState(),
          api.capabilities.listAuditEvents()
        ]);
      const activeWorkspaceId = workspaces[0]?.id ?? null;
      const activeConversationId =
        getFirstConversationIdForWorkspace(conversations, activeWorkspaceId) ??
        getFirstConversationIdForWorkspace(conversations, null);
      const [messages, knowledgeDocuments] = await Promise.all([
        activeConversationId === null
          ? Promise.resolve([])
          : api.chat.getConversationMessages(activeConversationId),
        activeWorkspaceId === null
          ? Promise.resolve([])
          : api.chat.listKnowledgeDocuments({ workspaceId: activeWorkspaceId })
      ]);

      set({
        initialized: true,
        bootstrapError: null,
        settings,
        systemStatus,
        workspaces,
        conversations,
        generationJobs,
        imageGenerationModelCatalog,
        availableTools,
        availableSkills,
        capabilityPermissions,
        capabilityTasks,
        capabilitySchedules,
        capabilityAgents,
        capabilityTeams,
        capabilityWorktrees,
        capabilityPlanState,
        capabilityAuditEvents,
        knowledgeDocumentsByWorkspace:
          activeWorkspaceId === null ? {} : { [activeWorkspaceId]: knowledgeDocuments },
        activeWorkspaceId,
        activeConversationId,
        messagesByConversation:
          activeConversationId === null
            ? {}
            : { [activeConversationId]: messages },
        selectedModel: '',
        selectedThinkMode: ''
      });
    } catch (error) {
      set({
        initialized: true,
        bootstrapError:
          error instanceof Error ? error.message : 'Unable to load app state.'
      });
    }
  },

  refreshGenerationJobs: async () => {
    const jobs = await getDesktopApi().generation.listJobs();
    set({ generationJobs: jobs });
  },

  inspectImageGenerationModels: async (additionalModelsDirectory) =>
    getDesktopApi().generation.listImageModels({
      additionalModelsDirectory: additionalModelsDirectory ?? null
    }),

  refreshCapabilitySurface: async () => {
    const api = getDesktopApi();
    const [
      capabilityPermissions,
      capabilityTasks,
      capabilitySchedules,
      capabilityAgents,
      capabilityTeams,
      capabilityWorktrees,
      capabilityPlanState,
      capabilityAuditEvents
    ] = await Promise.all([
      api.capabilities.listPermissions(),
      api.capabilities.listTasks(),
      api.capabilities.listSchedules(),
      api.capabilities.listAgents(),
      api.capabilities.listTeams(),
      api.capabilities.listWorktrees(),
      api.capabilities.getPlanState(),
      api.capabilities.listAuditEvents()
    ]);

    set({
      capabilityPermissions,
      capabilityTasks,
      capabilitySchedules,
      capabilityAgents,
      capabilityTeams,
      capabilityWorktrees,
      capabilityPlanState,
      capabilityAuditEvents
    });
  },

  refreshSystemStatus: async () => {
    const api = getDesktopApi();
    const status = await api.system.getStatus();
    set({ systemStatus: status });
  },

  rehydrateConversationMessages: async (conversationId) => {
    const messages = await getDesktopApi().chat.getConversationMessages(conversationId);

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: messages
      }
    }));
  },

  refreshWorkspaceKnowledge: async (workspaceId) => {
    const documents = await getDesktopApi().chat.listKnowledgeDocuments({ workspaceId });

    set((state) => ({
      knowledgeDocumentsByWorkspace: {
        ...state.knowledgeDocumentsByWorkspace,
        [workspaceId]: documents
      }
    }));
  },

  selectWorkspace: async (workspaceId) => {
    const state = get();
    const nextConversationId =
      state.activeConversationId &&
      state.conversations.some(
        (conversation) =>
          conversation.id === state.activeConversationId &&
          (workspaceId === null || conversation.workspaceId === workspaceId)
      )
        ? state.activeConversationId
        : getFirstConversationIdForWorkspace(state.conversations, workspaceId);

    if (nextConversationId === null) {
      set({ activeWorkspaceId: workspaceId, activeConversationId: null });

       if (workspaceId && !(workspaceId in state.knowledgeDocumentsByWorkspace)) {
        void get().refreshWorkspaceKnowledge(workspaceId);
      }

      return;
    }

    const existingMessages = state.messagesByConversation[nextConversationId];

    if (existingMessages) {
      set({
        activeWorkspaceId: workspaceId,
        activeConversationId: nextConversationId
      });

      if (workspaceId && !(workspaceId in state.knowledgeDocumentsByWorkspace)) {
        void get().refreshWorkspaceKnowledge(workspaceId);
      }

      return;
    }

    const messages = await getDesktopApi().chat.getConversationMessages(nextConversationId);
    set((currentState) => ({
      activeWorkspaceId: workspaceId,
      activeConversationId: nextConversationId,
      messagesByConversation: {
        ...currentState.messagesByConversation,
        [nextConversationId]: messages
      }
    }));

    if (workspaceId && !(workspaceId in get().knowledgeDocumentsByWorkspace)) {
      void get().refreshWorkspaceKnowledge(workspaceId);
    }
  },

  createWorkspace: async (input) => {
    const workspace = await getDesktopApi().chat.createWorkspace(input);

    set((state) => ({
      workspaces: upsertWorkspace(state.workspaces, workspace),
      activeWorkspaceId: workspace.id,
      activeConversationId: null,
      knowledgeDocumentsByWorkspace: {
        ...state.knowledgeDocumentsByWorkspace,
        [workspace.id]: []
      },
      lastImportPath: null,
      lastExportPath: null
    }));
  },

  pickWorkspaceDirectory: async () => {
    const selection = await getDesktopApi().chat.pickWorkspaceDirectory();
    return selection.path;
  },

  updateWorkspaceRoot: async (workspaceId, rootPath) => {
    const workspace = await getDesktopApi().chat.updateWorkspaceRoot({
      workspaceId,
      rootPath
    });

    set((state) => ({
      workspaces: upsertWorkspace(state.workspaces, workspace)
    }));
  },

  setSearchQuery: async (query) => {
    const trimmedQuery = query.trim();
    const requestId = latestSearchRequest + 1;
    latestSearchRequest = requestId;

    set({ searchQuery: query });

    if (!trimmedQuery) {
      set({ searchResults: [] });
      return;
    }

    const searchResults = await getDesktopApi().chat.searchConversations({
      query: trimmedQuery
    });

    if (latestSearchRequest !== requestId) {
      return;
    }

    set({ searchResults });
  },

  clearSearch: () => {
    latestSearchRequest += 1;
    set({ searchQuery: '', searchResults: [] });
  },

  selectConversation: async (conversationId) => {
    if (conversationId === null) {
      set({ activeConversationId: null });
      return;
    }

    const existing = get().messagesByConversation[conversationId];
    const conversation = get().conversations.find((item) => item.id === conversationId) ?? null;

    if (existing) {
      set({
        activeConversationId: conversationId,
        activeWorkspaceId: conversation?.workspaceId ?? get().activeWorkspaceId
      });
      return;
    }

    const messages = await getDesktopApi().chat.getConversationMessages(conversationId);
    set((state) => ({
      activeConversationId: conversationId,
      activeWorkspaceId: conversation?.workspaceId ?? state.activeWorkspaceId,
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: messages
      }
    }));
  },

  toggleSettingsDrawer: (open) => {
    set((state) => ({
      settingsDrawerOpen: open ?? !state.settingsDrawerOpen
    }));
  },

  toggleQueueDrawer: (open) => {
    set((state) => ({
      queueDrawerOpen: open ?? !state.queueDrawerOpen
    }));
  },

  togglePlanDrawer: (open) => {
    set((state) => ({
      planDrawerOpen: open ?? !state.planDrawerOpen
    }));
  },

  setSelectedModel: (model) => {
    set({ selectedModel: model });
  },

  setSelectedThinkMode: (thinkMode) => {
    set({ selectedThinkMode: thinkMode });
  },

  updateSettings: async (patch) => {
    const api = getDesktopApi();
    const previousSettings = get().settings;
    const nextSettings = await api.settings.update(patch);
    const [systemStatus, imageGenerationModelCatalog] = await Promise.all([
      api.system.getStatus(),
      api.generation.listImageModels({
        additionalModelsDirectory: nextSettings.additionalModelsDirectory
      })
    ]);
    const backendChanged =
      previousSettings !== null &&
      previousSettings.textInferenceBackend !== nextSettings.textInferenceBackend;

    set({
      settings: nextSettings,
      systemStatus,
      imageGenerationModelCatalog,
      selectedModel: backendChanged ? '' : get().selectedModel,
      selectedThinkMode:
        backendChanged || nextSettings.textInferenceBackend !== 'ollama'
          ? ''
          : get().selectedThinkMode
    });
  },

  grantCapabilityPermission: async (capabilityId) => {
    await getDesktopApi().capabilities.grantPermission({
      capabilityId,
      scopeKind: 'global',
      scopeId: null
    });
    await get().refreshCapabilitySurface();
  },

  revokeCapabilityPermission: async (capabilityId) => {
    await getDesktopApi().capabilities.revokePermission({
      capabilityId,
      scopeKind: 'global',
      scopeId: null
    });
    await get().refreshCapabilitySurface();
  },

  startImageGeneration: async (input) => {
    const api = getDesktopApi();
    const job = await api.generation.startImage(input);

    set((state) => ({
      generationJobs: upsertGenerationJobList(state.generationJobs, job)
    }));
  },

  sendPrompt: async (prompt, attachments = []) => {
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      return;
    }

    const api = getDesktopApi();
    const state = get();
    const selectedThinkMode = normalizeThinkModeSelection(state.selectedThinkMode);
    const accepted = await api.chat.start({
      conversationId: state.activeConversationId ?? undefined,
      workspaceId:
        state.activeConversationId === null
          ? state.activeWorkspaceId ?? undefined
          : undefined,
      prompt: trimmedPrompt,
      attachments,
      model: state.selectedModel || undefined,
      ...(selectedThinkMode ? { think: selectedThinkMode } : {})
    });

    if (accepted.kind === 'generation') {
      set((currentState) => ({
        activeConversationId: accepted.conversation.id,
        activeWorkspaceId:
          accepted.conversation.workspaceId ?? currentState.activeWorkspaceId,
        conversations: upsertConversation(
          currentState.conversations,
          accepted.conversation
        ),
        messagesByConversation:
          accepted.conversation.id in currentState.messagesByConversation
            ? currentState.messagesByConversation
            : {
                ...currentState.messagesByConversation,
                [accepted.conversation.id]: []
              },
        generationJobs: upsertGenerationJobList(
          currentState.generationJobs,
          accepted.job
        ),
        lastImportPath: null,
        lastExportPath: null
      }));
      return;
    }

    set((currentState) =>
      integrateAcceptedTurn(currentState, accepted, [
        ...(currentState.messagesByConversation[accepted.conversation.id] ?? []),
        accepted.userMessage,
        accepted.assistantMessage
      ])
    );

    if (accepted.conversation.workspaceId && attachments.some((attachment) => attachment.extractedText)) {
      void get().refreshWorkspaceKnowledge(accepted.conversation.workspaceId);
    }
  },

  editMessageAndResend: async (messageId, prompt, attachments = []) => {
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      return;
    }

    const api = getDesktopApi();
    const state = get();
    const selectedThinkMode = normalizeThinkModeSelection(state.selectedThinkMode);
    const accepted = await api.chat.editAndResend({
      messageId,
      prompt: trimmedPrompt,
      attachments,
      model: state.selectedModel || undefined,
      ...(selectedThinkMode ? { think: selectedThinkMode } : {})
    });
    const messages = await api.chat.getConversationMessages(accepted.conversation.id);

    set((currentState) => integrateAcceptedTurn(currentState, accepted, messages));

    if (accepted.conversation.workspaceId && attachments.some((attachment) => attachment.extractedText)) {
      void get().refreshWorkspaceKnowledge(accepted.conversation.workspaceId);
    }
  },

  regenerateResponse: async (assistantMessageId) => {
    const api = getDesktopApi();
    const state = get();
    const selectedThinkMode = normalizeThinkModeSelection(state.selectedThinkMode);
    const accepted = await api.chat.regenerateResponse({
      assistantMessageId,
      model: state.selectedModel || undefined,
      ...(selectedThinkMode ? { think: selectedThinkMode } : {})
    });
    const messages = await api.chat.getConversationMessages(accepted.conversation.id);

    set((currentState) => integrateAcceptedTurn(currentState, accepted, messages));
  },

  cancelChatTurn: async (assistantMessageId) => {
    await getDesktopApi().chat.cancelTurn({ assistantMessageId });
  },

  pinMessage: async (messageId, pinned) => {
    const updatedMessage = await getDesktopApi().chat.pinMessage({ messageId, pinned });

    set((state) => {
      const nextMessagesByConversation = { ...state.messagesByConversation };
      const messages = nextMessagesByConversation[updatedMessage.conversationId];

      if (!messages) {
        return state;
      }

      nextMessagesByConversation[updatedMessage.conversationId] = messages.map((message) =>
        message.id === updatedMessage.id ? updatedMessage : message
      );

      return {
        messagesByConversation: nextMessagesByConversation
      };
    });
  },

  importWorkspaceKnowledge: async () => {
    const workspaceId = get().activeWorkspaceId;

    if (!workspaceId) {
      throw new Error('Select a workspace before importing knowledge.');
    }

    await getDesktopApi().chat.importWorkspaceKnowledge({ workspaceId });
    await get().refreshWorkspaceKnowledge(workspaceId);
  },

  deleteConversation: async (conversationId) => {
    const api = getDesktopApi();
    const state = get();
    const deletedConversation = state.conversations.find(
      (conversation) => conversation.id === conversationId
    );

    if (!deletedConversation) {
      return;
    }

    await api.chat.deleteConversation({ conversationId });

    const deletedMessages = state.messagesByConversation[conversationId] ?? [];
    const deletedMessageIds = new Set(deletedMessages.map((message) => message.id));
    const remainingConversations = state.conversations.filter(
      (conversation) => conversation.id !== conversationId
    );
    const nextActiveConversationId =
      state.activeConversationId === conversationId
        ? getFirstConversationIdForWorkspace(
            remainingConversations,
            state.activeWorkspaceId
          ) ?? getFirstConversationIdForWorkspace(remainingConversations, null)
        : state.activeConversationId;
    const existingMessages =
      nextActiveConversationId === null
        ? undefined
        : state.messagesByConversation[nextActiveConversationId];

    set((currentState) => ({
      conversations: remainingConversations,
      generationJobs: currentState.generationJobs.map((job) =>
        job.conversationId === conversationId
          ? {
              ...job,
              conversationId: null
            }
          : job
      ),
      searchResults: currentState.searchResults.filter(
        (result) => result.conversation.id !== conversationId
      ),
      activeConversationId: nextActiveConversationId,
      messagesByConversation: Object.fromEntries(
        Object.entries(currentState.messagesByConversation).filter(
          ([existingConversationId]) => existingConversationId !== conversationId
        )
      ),
      streamingAssistantIds: currentState.streamingAssistantIds.filter(
        (assistantMessageId) => !deletedMessageIds.has(assistantMessageId)
      ),
      pendingStreamEventsByAssistantId: Object.fromEntries(
        Object.entries(currentState.pendingStreamEventsByAssistantId).filter(
          ([assistantMessageId]) => !deletedMessageIds.has(assistantMessageId)
        )
      ),
      lastImportPath: null,
      lastExportPath: null
    }));

    if (nextActiveConversationId && !existingMessages) {
      const messages = await api.chat.getConversationMessages(nextActiveConversationId);

      set((currentState) => ({
        messagesByConversation: {
          ...currentState.messagesByConversation,
          [nextActiveConversationId]: messages
        }
      }));
    }
  },

  importConversation: async () => {
    const api = getDesktopApi();
    const result = await api.chat.importConversation();
    const [workspaces, messages] = await Promise.all([
      api.chat.listWorkspaces(),
      api.chat.getConversationMessages(result.conversation.id)
    ]);

    set((state) => ({
      workspaces,
      conversations: upsertConversation(state.conversations, result.conversation),
      activeWorkspaceId: result.conversation.workspaceId ?? state.activeWorkspaceId,
      activeConversationId: result.conversation.id,
      messagesByConversation: {
        ...state.messagesByConversation,
        [result.conversation.id]: messages
      },
      lastImportPath: result.path,
      lastExportPath: null
    }));
  },

  exportActiveConversation: async (format = 'markdown') => {
    const conversationId = get().activeConversationId;

    if (!conversationId) {
      throw new Error('Select a conversation before exporting.');
    }

    const result = await getDesktopApi().chat.exportConversation({
      conversationId,
      format
    });

    set({ lastExportPath: result.path, lastImportPath: null });
  },

  cancelGenerationJob: async (jobId) => {
    const job = await getDesktopApi().generation.cancelJob({ jobId });

    set((state) => ({
      generationJobs: upsertGenerationJobList(state.generationJobs, job)
    }));
  },

  retryGenerationJob: async (jobId) => {
    const job = await getDesktopApi().generation.retryJob({ jobId });

    set((state) => ({
      generationJobs: upsertGenerationJobList(state.generationJobs, job)
    }));
  },

  applyStreamEvent: (event) => {
    const conversationId = findConversationIdByAssistantMessage(
      get().messagesByConversation,
      event.assistantMessageId
    );

    set((state) => {
      const appliedEvent = applyStreamEventToMessages(state.messagesByConversation, event);
      const nextPendingStreamEvents = appliedEvent.found
        ? removePendingStreamEvent(
            state.pendingStreamEventsByAssistantId,
            event.assistantMessageId
          )
        : {
            ...state.pendingStreamEventsByAssistantId,
            [event.assistantMessageId]: event
          };

      if (event.type === 'delta' || event.type === 'update') {
        return {
          messagesByConversation: appliedEvent.messagesByConversation,
          pendingStreamEventsByAssistantId: nextPendingStreamEvents
        };
      }

      return {
        messagesByConversation: appliedEvent.messagesByConversation,
        streamingAssistantIds: state.streamingAssistantIds.filter(
          (id) => id !== event.assistantMessageId
        ),
        pendingStreamEventsByAssistantId: nextPendingStreamEvents,
        systemStatus: state.systemStatus
          ? {
              ...state.systemStatus,
              pendingRequestCount: Math.max(
                0,
                state.systemStatus.pendingRequestCount - 1
              )
            }
          : state.systemStatus
      };
    });

    if (isTerminalStreamEvent(event)) {
      if (conversationId) {
        void get().rehydrateConversationMessages(conversationId);
      }
      void get().refreshCapabilitySurface();
    } else if (hasPlanTaskToolInvocation(event)) {
      void get().refreshCapabilitySurface();
    }
  },

  applyGenerationEvent: (event) => {
    if (event.type !== 'job-updated') {
      return;
    }

    set((state) => ({
      generationJobs: upsertGenerationJobList(state.generationJobs, event.job)
    }));
  }
}));
