import { create } from 'zustand';
import type {
  AgentSession,
  ChatRequestMode,
  ChatStartAccepted,
  AuditEventRecord,
  ChatTurnAccepted,
  ChatStreamEvent,
  CapabilityPermission,
  CapabilityTask,
  CreateSkillInput,
  ConversationSearchResult,
  ConversationSummary,
  DeleteSkillInput,
  GenerationConfirmationSelection,
  GenerationGalleryItem,
  GenerationJob,
  GenerationStreamEvent,
  ImageGenerationModelCatalog,
  ImageGenerationRequest,
  VideoGenerationRequest,
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
  UpdateSkillInput,
  UpdateUserSettings,
  UserSettings,
  WorktreeSession,
  WorkspaceSummary
} from '@bridge/ipc/contracts';
import { getDesktopApi } from '@renderer/lib/api';

let latestSearchRequest = 0;
let latestNavigationRequest = 0;

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

function sortSkills(skills: SkillDefinition[]) {
  return [...skills].sort((left, right) => left.title.localeCompare(right.title));
}

function upsertSkill(existing: SkillDefinition[], nextSkill: SkillDefinition) {
  const withoutExisting = existing.filter((skill) => skill.id !== nextSkill.id);
  return sortSkills([...withoutExisting, nextSkill]);
}

function upsertGenerationJobList(existing: GenerationJob[], nextJob: GenerationJob) {
  return [nextJob, ...existing.filter((job) => job.id !== nextJob.id)].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function sortMessagesByTimeline(messages: StoredMessage[]) {
  return [...messages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const createdAtDiff =
        new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime();

      if (createdAtDiff !== 0) {
        return createdAtDiff;
      }

      const updatedAtDiff =
        new Date(left.message.updatedAt).getTime() - new Date(right.message.updatedAt).getTime();

      if (updatedAtDiff !== 0) {
        return updatedAtDiff;
      }

      return left.index - right.index;
    })
    .map(({ message }) => message);
}

function mergeConversationMessages(
  existing: StoredMessage[],
  incoming: StoredMessage[]
) {
  const dedupedMessages = new Map<string, StoredMessage>();

  for (const message of [...existing, ...incoming]) {
    dedupedMessages.set(message.id, message);
  }

  return sortMessagesByTimeline([...dedupedMessages.values()]);
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

function getCapabilitySurfacePatch(event: ChatStreamEvent) {
  if (event.type !== 'update' && event.type !== 'complete') {
    return {};
  }

  return {
    ...(event.capabilityTasks === undefined ? {} : { capabilityTasks: event.capabilityTasks }),
    ...(event.capabilityPlanState === undefined
      ? {}
      : { capabilityPlanState: event.capabilityPlanState })
  };
}

function hasCapabilitySurfaceSnapshot(event: ChatStreamEvent): boolean {
  return (
    (event.type === 'update' || event.type === 'complete') &&
    (event.capabilityTasks !== undefined || event.capabilityPlanState !== undefined)
  );
}

function applyAssistantStreamSnapshot(
  message: StoredMessage,
  snapshot: {
    content: string;
    status: StoredMessage['status'];
    model?: StoredMessage['model'];
    toolInvocationCount?: number;
    toolInvocations?: StoredMessage['toolInvocations'];
    contextSourceCount?: number;
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
    toolInvocationCount:
      snapshot.toolInvocationCount === undefined
        ? snapshot.toolInvocations === undefined
          ? message.toolInvocationCount ?? message.toolInvocations?.length ?? 0
          : snapshot.toolInvocations.length
        : snapshot.toolInvocationCount,
    toolInvocations:
      snapshot.toolInvocations === undefined
        ? snapshot.toolInvocationCount !== undefined &&
          message.toolInvocations !== undefined &&
          snapshot.toolInvocationCount !== message.toolInvocations.length
          ? undefined
          : message.toolInvocations
        : snapshot.toolInvocations,
    contextSourceCount:
      snapshot.contextSourceCount === undefined
        ? snapshot.contextSources === undefined
          ? message.contextSourceCount ?? message.contextSources?.length ?? 0
          : snapshot.contextSources.length
        : snapshot.contextSourceCount,
    contextSources:
      snapshot.contextSources === undefined
        ? snapshot.contextSourceCount !== undefined &&
          message.contextSources !== undefined &&
          snapshot.contextSourceCount !== message.contextSources.length
          ? undefined
          : message.contextSources
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
  if (event.type === 'message-created') {
    return {
      found: true,
      messagesByConversation: {
        ...messagesByConversation,
        [event.conversationId]: mergeConversationMessages(
          messagesByConversation[event.conversationId] ?? [],
          [event.message]
        )
      }
    };
  }

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
        ...(event.toolInvocationCount === undefined
          ? {}
          : { toolInvocationCount: event.toolInvocationCount }),
        ...(event.toolInvocations === undefined
          ? {}
          : { toolInvocations: event.toolInvocations }),
        ...(event.contextSourceCount === undefined
          ? {}
          : { contextSourceCount: event.contextSourceCount }),
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
        ...(event.toolInvocationCount === undefined
          ? {}
          : { toolInvocationCount: event.toolInvocationCount }),
        ...(event.toolInvocations === undefined
          ? {}
          : { toolInvocations: event.toolInvocations }),
        ...(event.contextSourceCount === undefined
          ? {}
          : { contextSourceCount: event.contextSourceCount }),
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
    pendingGenerationConfirmation: null,
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

function integrateGenerationConfirmation(
  state: AppStoreState,
  accepted: PendingGenerationConfirmation
) {
  return {
    activeConversationId: accepted.conversation.id,
    activeWorkspaceId: accepted.conversation.workspaceId ?? state.activeWorkspaceId,
    conversations: upsertConversation(state.conversations, accepted.conversation),
    messagesByConversation:
      accepted.conversation.id in state.messagesByConversation
        ? state.messagesByConversation
        : {
            ...state.messagesByConversation,
            [accepted.conversation.id]: []
          },
    pendingGenerationConfirmation: accepted,
    lastImportPath: null,
    lastExportPath: null
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

type PendingGenerationConfirmation = Extract<
  ChatStartAccepted,
  { kind: 'generation-confirmation' }
>;

interface AppStoreState {
  initialized: boolean;
  bootstrapError: string | null;
  settings: UserSettings | null;
  systemStatus: SystemStatus | null;
  workspaces: WorkspaceSummary[];
  conversations: ConversationSummary[];
  generationJobs: GenerationJob[];
  generationGalleryItems: GenerationGalleryItem[];
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
  pendingGenerationConfirmation: PendingGenerationConfirmation | null;
  selectedModel: string;
  selectedThinkMode: ChatThinkModeSelection;
  settingsDrawerOpen: boolean;
  queueDrawerOpen: boolean;
  galleryDrawerOpen: boolean;
  planDrawerOpen: boolean;
  agentsDrawerOpen: boolean;
  skillsDrawerOpen: boolean;
  sidebarOpen: boolean;
  streamingAssistantIds: string[];
  pendingStreamEventsByAssistantId: Record<string, ChatStreamEvent>;
  lastExportPath: string | null;
  lastImportPath: string | null;
  loadInitialData: () => Promise<void>;
  refreshGenerationJobs: () => Promise<void>;
  refreshGenerationGallery: () => Promise<void>;
  inspectImageGenerationModels: (
    additionalModelsDirectory?: string | null
  ) => Promise<ImageGenerationModelCatalog>;
  refreshCapabilitySurface: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshSystemStatus: () => Promise<void>;
  rehydrateConversationMessages: (conversationId: string) => Promise<void>;
  loadMessageArtifacts: (messageId: string) => Promise<void>;
  refreshWorkspaceKnowledge: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string | null) => Promise<void>;
  createWorkspace: (input: { name: string; rootPath: string }) => Promise<void>;
  pickWorkspaceDirectory: () => Promise<string | null>;
  updateWorkspaceRoot: (workspaceId: string, rootPath: string | null) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  setSearchQuery: (query: string) => Promise<void>;
  clearSearch: () => void;
  selectConversation: (conversationId: string | null) => Promise<void>;
  toggleSettingsDrawer: (open?: boolean) => void;
  toggleQueueDrawer: (open?: boolean) => void;
  toggleGalleryDrawer: (open?: boolean) => void;
  togglePlanDrawer: (open?: boolean) => void;
  toggleAgentsDrawer: (open?: boolean) => void;
  toggleSkillsDrawer: (open?: boolean) => void;
  toggleSidebar: (open?: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSelectedThinkMode: (thinkMode: ChatThinkModeSelection) => void;
  updateSettings: (patch: UpdateUserSettings) => Promise<void>;
  createSkill: (input: CreateSkillInput) => Promise<SkillDefinition>;
  updateSkill: (input: UpdateSkillInput) => Promise<SkillDefinition>;
  deleteSkill: (input: DeleteSkillInput) => Promise<void>;
  grantCapabilityPermission: (capabilityId: string) => Promise<void>;
  revokeCapabilityPermission: (capabilityId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  startImageGeneration: (
    input: ImageGenerationRequest
  ) => Promise<void>;
  startVideoGeneration: (
    input: VideoGenerationRequest
  ) => Promise<void>;
  sendPrompt: (
    prompt: string,
    attachments?: MessageAttachment[],
    mode?: ChatRequestMode
  ) => Promise<ChatStartAccepted['kind'] | null>;
  confirmGenerationSelection: (
    selection: GenerationConfirmationSelection
  ) => Promise<ChatStartAccepted['kind'] | null>;
  dismissGenerationConfirmation: () => void;
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
  deleteGenerationArtifact: (artifactId: string) => Promise<void>;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  initialized: false,
  bootstrapError: null,
  settings: null,
  systemStatus: null,
  workspaces: [],
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
  activeWorkspaceId: null,
  activeConversationId: null,
  messagesByConversation: {},
  pendingGenerationConfirmation: null,
  selectedModel: '',
  selectedThinkMode: '',
  settingsDrawerOpen: false,
  queueDrawerOpen: false,
  galleryDrawerOpen: false,
  planDrawerOpen: false,
  agentsDrawerOpen: false,
  skillsDrawerOpen: false,
  sidebarOpen: typeof window !== 'undefined' ? window.matchMedia('(min-width: 1280px)').matches : false,
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
        generationGalleryItems,
        imageGenerationModelCatalog,
        availableTools,
        availableSkills,
        capabilityPermissions,
        capabilitySchedules,
        capabilityAgents,
        capabilityTeams,
        capabilityWorktrees,
        capabilityAuditEvents
      ] =
        await Promise.all([
          api.system.getStatus(),
          api.chat.listWorkspaces(),
          api.chat.listConversations(),
          api.generation.listJobs(),
          api.generation.listGallery(),
          api.generation.listImageModels({
            additionalModelsDirectory: settings.additionalModelsDirectory
          }),
          api.chat.listTools(),
          api.chat.listSkills(),
          api.capabilities.listPermissions(),
          api.capabilities.listSchedules(),
          api.capabilities.listAgents(),
          api.capabilities.listTeams(),
          api.capabilities.listWorktrees(),
          api.capabilities.listAuditEvents()
        ]);
      const activeWorkspaceId = workspaces[0]?.id ?? null;
      const activeConversationId =
        getFirstConversationIdForWorkspace(conversations, activeWorkspaceId) ??
        getFirstConversationIdForWorkspace(conversations, null);
      const [
        messages,
        knowledgeDocuments,
        capabilityTasks,
        capabilityPlanState
      ] = await Promise.all([
        activeConversationId === null
          ? Promise.resolve([])
          : api.chat.getConversationMessages(activeConversationId),
        activeWorkspaceId === null
          ? Promise.resolve([])
          : api.chat.listKnowledgeDocuments({ workspaceId: activeWorkspaceId }),
        api.capabilities.listTasks(activeWorkspaceId),
        api.capabilities.getPlanState(activeWorkspaceId)
      ]);

      set({
        initialized: true,
        bootstrapError: null,
        settings,
        systemStatus,
        workspaces,
        conversations,
        generationJobs,
        generationGalleryItems,
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

    const sidebarMql = window.matchMedia('(min-width: 1280px)');
    const handleSidebarResize = () => {
      set({ sidebarOpen: sidebarMql.matches });
    };
    sidebarMql.addEventListener('change', handleSidebarResize);
  },

  refreshGenerationJobs: async () => {
    const jobs = await getDesktopApi().generation.listJobs();
    set({ generationJobs: jobs });
  },

  refreshGenerationGallery: async () => {
    const generationGalleryItems = await getDesktopApi().generation.listGallery();
    set({ generationGalleryItems });
  },

  inspectImageGenerationModels: async (additionalModelsDirectory) =>
    getDesktopApi().generation.listImageModels({
      additionalModelsDirectory: additionalModelsDirectory ?? null
    }),

  refreshCapabilitySurface: async () => {
    const api = getDesktopApi();
    const { activeWorkspaceId } = get();
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
      api.capabilities.listTasks(activeWorkspaceId),
      api.capabilities.listSchedules(),
      api.capabilities.listAgents(),
      api.capabilities.listTeams(),
      api.capabilities.listWorktrees(),
      api.capabilities.getPlanState(activeWorkspaceId),
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

  refreshSkills: async () => {
    const availableSkills = await getDesktopApi().chat.listSkills();
    set({ availableSkills: sortSkills(availableSkills) });
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

  loadMessageArtifacts: async (messageId) => {
    const detailedMessage = await getDesktopApi().chat.getMessage(messageId);

    if (!detailedMessage) {
      return;
    }

    set((state) => {
      const nextMessagesByConversation = { ...state.messagesByConversation };
      const messages = nextMessagesByConversation[detailedMessage.conversationId];

      if (!messages) {
        return state;
      }

      nextMessagesByConversation[detailedMessage.conversationId] = messages.map((message) =>
        message.id === detailedMessage.id ? detailedMessage : message
      );

      return {
        messagesByConversation: nextMessagesByConversation
      };
    });
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
    const navigationRequestId = ++latestNavigationRequest;
    const nextConversationId =
      state.activeConversationId &&
      state.conversations.some(
        (conversation) =>
          conversation.id === state.activeConversationId &&
          (workspaceId === null || conversation.workspaceId === workspaceId)
      )
        ? state.activeConversationId
        : getFirstConversationIdForWorkspace(state.conversations, workspaceId);

    set({
      activeWorkspaceId: workspaceId,
      activeConversationId: nextConversationId,
      pendingGenerationConfirmation: null
    });

    if (nextConversationId === null) {
      if (workspaceId && !(workspaceId in state.knowledgeDocumentsByWorkspace)) {
        void get().refreshWorkspaceKnowledge(workspaceId);
      }

      return;
    }

    const existingMessages = state.messagesByConversation[nextConversationId];

    if (existingMessages) {
      if (workspaceId && !(workspaceId in state.knowledgeDocumentsByWorkspace)) {
        void get().refreshWorkspaceKnowledge(workspaceId);
      }

      return;
    }

    const messages = await getDesktopApi().chat.getConversationMessages(nextConversationId);

    if (navigationRequestId !== latestNavigationRequest) {
      return;
    }

    set((currentState) => ({
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
      pendingGenerationConfirmation: null,
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

  deleteWorkspace: async (workspaceId) => {
    await getDesktopApi().chat.deleteWorkspace({ workspaceId });

    const state = get();
    const remaining = state.workspaces.filter((w) => w.id !== workspaceId);
    const nextWorkspaceId = remaining[0]?.id ?? null;
    const nextConversationId = getFirstConversationIdForWorkspace(
      state.conversations,
      nextWorkspaceId
    );

    const deletedConversationIds = new Set(
      state.conversations
        .filter((c) => c.workspaceId === workspaceId)
        .map((c) => c.id)
    );

    set((currentState) => ({
      workspaces: remaining,
      conversations: currentState.conversations.filter(
        (c) => !deletedConversationIds.has(c.id)
      ),
      generationJobs: currentState.generationJobs.filter(
        (job) => job.workspaceId !== workspaceId && !deletedConversationIds.has(job.conversationId ?? '')
      ),
      messagesByConversation: Object.fromEntries(
        Object.entries(currentState.messagesByConversation).filter(
          ([id]) => !deletedConversationIds.has(id)
        )
      ),
      activeWorkspaceId: nextWorkspaceId,
      activeConversationId: deletedConversationIds.has(
        currentState.activeConversationId ?? ''
      )
        ? nextConversationId
        : currentState.activeConversationId,
      pendingGenerationConfirmation:
        deletedConversationIds.has(
          currentState.pendingGenerationConfirmation?.conversation.id ?? ''
        )
          ? null
          : currentState.pendingGenerationConfirmation,
      knowledgeDocumentsByWorkspace: Object.fromEntries(
        Object.entries(currentState.knowledgeDocumentsByWorkspace).filter(
          ([id]) => id !== workspaceId
        )
      )
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
    const navigationRequestId = ++latestNavigationRequest;

    if (conversationId === null) {
      set({ activeConversationId: null, pendingGenerationConfirmation: null });
      return;
    }

    const existing = get().messagesByConversation[conversationId];
    const conversation = get().conversations.find((item) => item.id === conversationId) ?? null;

    set({
      activeConversationId: conversationId,
      activeWorkspaceId: conversation?.workspaceId ?? get().activeWorkspaceId,
      pendingGenerationConfirmation: null
    });

    if (existing) {
      return;
    }

    const messages = await getDesktopApi().chat.getConversationMessages(conversationId);

    if (navigationRequestId !== latestNavigationRequest) {
      return;
    }

    set((state) => ({
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

  toggleGalleryDrawer: (open) => {
    const opening = open ?? !get().galleryDrawerOpen;
    set({ galleryDrawerOpen: opening });

    if (opening) {
      void get().refreshGenerationGallery();
    }
  },

  togglePlanDrawer: (open) => {
    set((state) => ({
      planDrawerOpen: open ?? !state.planDrawerOpen
    }));
  },

  toggleAgentsDrawer: (open) => {
    set((state) => ({
      agentsDrawerOpen: open ?? !state.agentsDrawerOpen
    }));
  },

  toggleSkillsDrawer: (open) => {
    set((state) => ({
      skillsDrawerOpen: open ?? !state.skillsDrawerOpen
    }));
  },

  toggleSidebar: (open) => {
    set((state) => ({
      sidebarOpen: open ?? !state.sidebarOpen
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

  createSkill: async (input) => {
    const skill = await getDesktopApi().chat.createSkill(input);
    set((state) => ({
      availableSkills: upsertSkill(state.availableSkills, skill)
    }));
    return skill;
  },

  updateSkill: async (input) => {
    const skill = await getDesktopApi().chat.updateSkill(input);
    set((state) => ({
      availableSkills: upsertSkill(state.availableSkills, skill)
    }));
    return skill;
  },

  deleteSkill: async (input) => {
    await getDesktopApi().chat.deleteSkill(input);
    set((state) => ({
      availableSkills: state.availableSkills.filter((skill) => skill.id !== input.skillId)
    }));
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

  deleteTask: async (taskId) => {
    await getDesktopApi().capabilities.deleteTask(taskId);
    await get().refreshCapabilitySurface();
  },

  startImageGeneration: async (input) => {
    const api = getDesktopApi();
    const result = await api.generation.startImage(input);

    set((state) => ({
      ...(result.conversation
        ? {
            activeConversationId: result.conversation.id,
            activeWorkspaceId:
              result.conversation.workspaceId ?? state.activeWorkspaceId,
            conversations: upsertConversation(state.conversations, result.conversation),
            messagesByConversation:
              result.conversation.id in state.messagesByConversation
                ? state.messagesByConversation
                : {
                    ...state.messagesByConversation,
                    [result.conversation.id]: []
                  }
          }
        : {}),
      pendingGenerationConfirmation: null,
      generationJobs: upsertGenerationJobList(state.generationJobs, result.job)
    }));
  },

  startVideoGeneration: async (input) => {
    const api = getDesktopApi();
    const result = await api.generation.startVideo(input);

    set((state) => ({
      ...(result.conversation
        ? {
            activeConversationId: result.conversation.id,
            activeWorkspaceId:
              result.conversation.workspaceId ?? state.activeWorkspaceId,
            conversations: upsertConversation(state.conversations, result.conversation),
            messagesByConversation:
              result.conversation.id in state.messagesByConversation
                ? state.messagesByConversation
                : {
                    ...state.messagesByConversation,
                    [result.conversation.id]: []
                  }
          }
        : {}),
      pendingGenerationConfirmation: null,
      generationJobs: upsertGenerationJobList(state.generationJobs, result.job)
    }));
  },

  sendPrompt: async (prompt, attachments = [], mode = 'chat') => {
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      return null;
    }

    const api = getDesktopApi();
    const state = get();
    const activeConversation =
      state.activeConversationId === null
        ? null
        : state.conversations.find((conversation) => conversation.id === state.activeConversationId) ??
          null;
    const useActiveConversation =
      activeConversation !== null &&
      (state.activeWorkspaceId === null || activeConversation.workspaceId === state.activeWorkspaceId);
    const selectedThinkMode = normalizeThinkModeSelection(state.selectedThinkMode);
    const accepted = await api.chat.start({
      conversationId: useActiveConversation ? activeConversation.id : undefined,
      workspaceId: useActiveConversation ? undefined : state.activeWorkspaceId ?? undefined,
      prompt: trimmedPrompt,
      attachments,
      model: state.selectedModel || undefined,
      ...(mode === 'wireframe' ? { mode } : {}),
      ...(selectedThinkMode ? { think: selectedThinkMode } : {})
    });

    if (accepted.kind === 'generation-confirmation') {
      set((currentState) => integrateGenerationConfirmation(currentState, accepted));
      return accepted.kind;
    }

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
        pendingGenerationConfirmation: null,
        generationJobs: upsertGenerationJobList(
          currentState.generationJobs,
          accepted.job
        ),
        lastImportPath: null,
        lastExportPath: null
      }));
      return accepted.kind;
    }

    set((currentState) =>
      integrateAcceptedTurn(
        currentState,
        accepted,
        mergeConversationMessages(
          currentState.messagesByConversation[accepted.conversation.id] ?? [],
          [accepted.userMessage, accepted.assistantMessage]
        )
      )
    );

    if (
      accepted.conversation.workspaceId &&
      attachments.some((attachment) => attachment.extractedText)
    ) {
      void get().refreshWorkspaceKnowledge(accepted.conversation.workspaceId);
    }

    return accepted.kind;
  },

  confirmGenerationSelection: async (selection) => {
    const api = getDesktopApi();
    const state = get();
    const pending = state.pendingGenerationConfirmation;

    if (!pending) {
      return null;
    }

    const selectedThinkMode = normalizeThinkModeSelection(state.selectedThinkMode);
    const accepted = await api.chat.confirmGenerationIntent({
      conversationId: pending.conversation.id,
      prompt: pending.prompt,
      attachments: pending.attachments,
      selection,
      model: state.selectedModel || undefined,
      ...(selectedThinkMode ? { think: selectedThinkMode } : {})
    });

    if (accepted.kind === 'generation-confirmation') {
      set((currentState) => integrateGenerationConfirmation(currentState, accepted));
      return accepted.kind;
    }

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
        pendingGenerationConfirmation: null,
        generationJobs: upsertGenerationJobList(
          currentState.generationJobs,
          accepted.job
        ),
        lastImportPath: null,
        lastExportPath: null
      }));
      return accepted.kind;
    }

    const messages = await api.chat.getConversationMessages(accepted.conversation.id);
    set((currentState) => integrateAcceptedTurn(currentState, accepted, messages));
    return accepted.kind;
  },

  dismissGenerationConfirmation: () => {
    set({ pendingGenerationConfirmation: null });
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
      generationJobs: currentState.generationJobs.filter(
        (job) => job.conversationId !== conversationId
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
      pendingGenerationConfirmation:
        currentState.pendingGenerationConfirmation?.conversation.id === conversationId
          ? null
          : currentState.pendingGenerationConfirmation,
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
      pendingGenerationConfirmation: null,
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
    const result = await getDesktopApi().generation.retryJob({ jobId });

    set((state) => ({
      ...(result.conversation
        ? {
            activeConversationId: result.conversation.id,
            activeWorkspaceId:
              result.conversation.workspaceId ?? state.activeWorkspaceId,
            conversations: upsertConversation(state.conversations, result.conversation),
            messagesByConversation:
              result.conversation.id in state.messagesByConversation
                ? state.messagesByConversation
                : {
                    ...state.messagesByConversation,
                    [result.conversation.id]: []
                  }
          }
        : {}),
      generationJobs: upsertGenerationJobList(state.generationJobs, result.job)
    }));
  },

  deleteGenerationArtifact: async (artifactId) => {
    const state = get();
    const galleryItem = state.generationGalleryItems.find((item) => item.id === artifactId);
    await getDesktopApi().generation.deleteArtifact(
      galleryItem?.artifactId
        ? { artifactId: galleryItem.artifactId }
        : { filePath: galleryItem?.filePath ?? artifactId }
    );

    await Promise.all([
      get().refreshGenerationJobs(),
      get().refreshGenerationGallery()
    ]);
  },

  applyStreamEvent: (event) => {
    const assistantMessageId = event.assistantMessageId;
    const bufferedPendingEvent =
      event.type === 'message-created'
        ? get().pendingStreamEventsByAssistantId[assistantMessageId]
        : undefined;
    const followUpEvent = bufferedPendingEvent ?? event;
    const conversationId =
      event.type === 'message-created'
        ? event.conversationId
        : findConversationIdByAssistantMessage(
            get().messagesByConversation,
            assistantMessageId
          );

    set((state) => {
      let appliedEvent = applyStreamEventToMessages(state.messagesByConversation, event);
      let nextPendingStreamEvents = appliedEvent.found
        ? removePendingStreamEvent(
            state.pendingStreamEventsByAssistantId,
            assistantMessageId
          )
        : {
            ...state.pendingStreamEventsByAssistantId,
            [assistantMessageId]: event
          };
      let effectiveEvent = event;

      if (event.type === 'message-created') {
        const pendingEvent = state.pendingStreamEventsByAssistantId[assistantMessageId];

        if (pendingEvent) {
          appliedEvent = applyStreamEventToMessages(
            appliedEvent.messagesByConversation,
            pendingEvent
          );
          effectiveEvent = pendingEvent;
          nextPendingStreamEvents = removePendingStreamEvent(
            nextPendingStreamEvents,
            assistantMessageId
          );
        }
      }

      const capabilitySurfacePatch = getCapabilitySurfacePatch(effectiveEvent);
      const nextStreamingAssistantIds =
        effectiveEvent.type === 'complete' || effectiveEvent.type === 'error'
          ? state.streamingAssistantIds.filter((id) => id !== assistantMessageId)
          : effectiveEvent.type === 'update'
            ? effectiveEvent.status === 'streaming'
              ? upsertStreamingAssistantId(state.streamingAssistantIds, assistantMessageId)
              : state.streamingAssistantIds.filter((id) => id !== assistantMessageId)
            : effectiveEvent.type === 'delta'
              ? upsertStreamingAssistantId(state.streamingAssistantIds, assistantMessageId)
              : effectiveEvent.message.status === 'streaming'
                ? upsertStreamingAssistantId(state.streamingAssistantIds, assistantMessageId)
                : state.streamingAssistantIds.filter((id) => id !== assistantMessageId);

      if (effectiveEvent.type === 'delta' || effectiveEvent.type === 'update') {
        return {
          messagesByConversation: appliedEvent.messagesByConversation,
          streamingAssistantIds: nextStreamingAssistantIds,
          pendingStreamEventsByAssistantId: nextPendingStreamEvents,
          ...capabilitySurfacePatch
        };
      }

      return {
        messagesByConversation: appliedEvent.messagesByConversation,
        streamingAssistantIds: nextStreamingAssistantIds,
        pendingStreamEventsByAssistantId: nextPendingStreamEvents,
        ...capabilitySurfacePatch,
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

    if (isTerminalStreamEvent(followUpEvent)) {
      if (conversationId) {
        void get().rehydrateConversationMessages(conversationId);
      }
      if (!hasCapabilitySurfaceSnapshot(followUpEvent)) {
        void get().refreshCapabilitySurface();
      }
    } else if (
      !hasCapabilitySurfaceSnapshot(followUpEvent) &&
      hasPlanTaskToolInvocation(followUpEvent)
    ) {
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
    void get().refreshGenerationGallery();
  }
}));
