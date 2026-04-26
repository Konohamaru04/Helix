import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ChatRequestMode,
  type GenerationArtifact,
  type GenerationGalleryItem,
  type MessageAttachment,
  type StoredMessage,
  type UserSettings
} from '@bridge/ipc/contracts';
import { AgentsDrawer } from '@renderer/components/agents-drawer';
import { ChatComposer } from '@renderer/components/chat-composer';
import { DesktopOnlyNotice } from '@renderer/components/desktop-only-notice';
import { GalleryDrawer } from '@renderer/components/gallery-drawer';
import { MessageList } from '@renderer/components/message-list';
import { PlanDrawer } from '@renderer/components/plan-drawer';
import { QueueDrawer } from '@renderer/components/queue-drawer';
import { SkillsDrawer } from '@renderer/components/skills-drawer';
import { SettingsDrawer } from '@renderer/components/settings-drawer';
import { Sidebar } from '@renderer/components/sidebar';
import { StatusBar } from '@renderer/components/status-bar';
import { StreamingMascot } from '@renderer/components/streaming-mascot';
import { TitleBar } from '@renderer/components/title-bar';
import { useAppBootstrap } from '@renderer/hooks/use-app-bootstrap';
import { getDesktopApi, hasDesktopApi } from '@renderer/lib/api';
import {
  getConfiguredImageGenerationModelOption,
  getImageGenerationModelLabel
} from '@renderer/lib/image-generation-models';
import {
  parseWireframeArtifact,
  parseWireframeArtifacts
} from '@renderer/lib/wireframe';
import { useAppStore } from '@renderer/store/app-store';

function mergeAttachments(
  existing: MessageAttachment[],
  next: MessageAttachment[]
): MessageAttachment[] {
  const merged = [...existing];

  for (const attachment of next) {
    const alreadyPresent = merged.some(
      (item) =>
        item.filePath === attachment.filePath &&
        item.fileName === attachment.fileName &&
        item.sizeBytes === attachment.sizeBytes
    );

    if (!alreadyPresent) {
      merged.push(attachment);
    }
  }

  return merged.slice(0, 8);
}

function getFileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop()?.trim() || filePath;
}

function createGeneratedMediaAttachment(
  artifact: Pick<GenerationArtifact, 'filePath' | 'mimeType' | 'createdAt'>
): MessageAttachment {
  return {
    id: crypto.randomUUID(),
    fileName: getFileNameFromPath(artifact.filePath),
    filePath: artifact.filePath,
    mimeType: artifact.mimeType,
    sizeBytes: null,
    extractedText: null,
    createdAt: new Date().toISOString()
  };
}

type ComposerMode = 'chat' | 'image' | 'video' | 'wireframe';
type SubmitPhase = ComposerMode | 'edit';

function getSubmitFeedback(phase: SubmitPhase | null) {
  if (phase === 'chat') {
    return {
      label: 'Analyzing...',
      hint: 'The base model is classifying this request and selecting the best route.',
      transcriptLabel: 'Analyzing request',
      transcriptHint:
        'The bridge is checking intent, tools, and specialist models before the response starts streaming.'
    };
  }

  if (phase === 'image') {
    return {
      label: 'Queueing...',
      hint: 'Preparing the image job and verifying the selected generation backend.',
      transcriptLabel: 'Preparing image job',
      transcriptHint:
        'The bridge is packaging the prompt, references, and backend settings before queueing the job.'
    };
  }

  if (phase === 'video') {
    return {
      label: 'Queueing...',
      hint: 'Preparing the image-to-video job and validating the paired Wan 2.2 models.',
      transcriptLabel: 'Preparing video job',
      transcriptHint:
        'The bridge is packaging the start frame, paired Wan checkpoints, and workflow defaults before the video job enters the queue.'
    };
  }

  if (phase === 'wireframe') {
    return {
      label: 'Thinking...',
      hint: 'The model is shaping the wireframe requirements or updating the live canvas.',
      transcriptLabel: 'Preparing wireframe turn',
      transcriptHint:
        'Wireframe mode is keeping the response structured for questions and HTML/CSS/JS preview output.'
    };
  }

  if (phase === 'edit') {
    return {
      label: 'Resending...',
      hint: 'Updating the last user turn and routing the refreshed request.',
      transcriptLabel: 'Refreshing edited turn',
      transcriptHint:
        'The bridge is replacing the edited message and preparing a new assistant run.'
    };
  }

  return null;
}

function resolveTheme(
  theme: UserSettings['theme'] | undefined,
  prefersDark: boolean
): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') {
    return theme;
  }

  return prefersDark ? 'dark' : 'light';
}

export function ChatPage() {
  useAppBootstrap();
  const desktopRuntimeAvailable = hasDesktopApi();

  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDraftConversationRef = useRef<string | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<MessageAttachment[]>([]);
  const [composerMode, setComposerMode] = useState<ComposerMode>('chat');
  const [wireframeConversationIds, setWireframeConversationIds] = useState<Set<string>>(
    () => new Set()
  );
  const [wireframeDisabledConversationIds, setWireframeDisabledConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedWireframeIterationIds, setSelectedWireframeIterationIds] = useState<
    Map<string, string>
  >(() => new Map());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [workspaceRootDraft, setWorkspaceRootDraft] = useState<string | null>(null);
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase | null>(null);
  const submitLockRef = useRef(false);
  const initialized = useAppStore((state) => state.initialized);
  const bootstrapError = useAppStore((state) => state.bootstrapError);
  const settings = useAppStore((state) => state.settings);
  const systemStatus = useAppStore((state) => state.systemStatus);
  const workspaces = useAppStore((state) => state.workspaces);
  const conversations = useAppStore((state) => state.conversations);
  const generationJobs = useAppStore((state) => state.generationJobs);
  const generationGalleryItems = useAppStore((state) => state.generationGalleryItems);
  const imageGenerationModelCatalog = useAppStore(
    (state) => state.imageGenerationModelCatalog
  );
  const availableTools = useAppStore((state) => state.availableTools);
  const availableSkills = useAppStore((state) => state.availableSkills);
  const capabilityPermissions = useAppStore((state) => state.capabilityPermissions);
  const capabilityTasks = useAppStore((state) => state.capabilityTasks);
  const capabilitySchedules = useAppStore((state) => state.capabilitySchedules);
  const capabilityAgents = useAppStore((state) => state.capabilityAgents);
  const capabilityTeams = useAppStore((state) => state.capabilityTeams);
  const capabilityWorktrees = useAppStore((state) => state.capabilityWorktrees);
  const capabilityPlanState = useAppStore((state) => state.capabilityPlanState);
  const capabilityAuditEvents = useAppStore((state) => state.capabilityAuditEvents);
  const knowledgeDocumentsByWorkspace = useAppStore(
    (state) => state.knowledgeDocumentsByWorkspace
  );
  const searchQuery = useAppStore((state) => state.searchQuery);
  const searchResults = useAppStore((state) => state.searchResults);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const messagesByConversation = useAppStore((state) => state.messagesByConversation);
  const pendingGenerationConfirmation = useAppStore(
    (state) => state.pendingGenerationConfirmation
  );
  const selectedModel = useAppStore((state) => state.selectedModel);
  const selectedThinkMode = useAppStore((state) => state.selectedThinkMode);
  const settingsDrawerOpen = useAppStore((state) => state.settingsDrawerOpen);
  const queueDrawerOpen = useAppStore((state) => state.queueDrawerOpen);
  const galleryDrawerOpen = useAppStore((state) => state.galleryDrawerOpen);
  const agentsDrawerOpen = useAppStore((state) => state.agentsDrawerOpen);
  const skillsDrawerOpen = useAppStore((state) => state.skillsDrawerOpen);
  const streamingAssistantIds = useAppStore((state) => state.streamingAssistantIds);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const createWorkspace = useAppStore((state) => state.createWorkspace);
  const pickWorkspaceDirectory = useAppStore((state) => state.pickWorkspaceDirectory);
  const updateWorkspaceRoot = useAppStore((state) => state.updateWorkspaceRoot);
  const deleteWorkspace = useAppStore((state) => state.deleteWorkspace);
  const refreshWorkspaceKnowledge = useAppStore((state) => state.refreshWorkspaceKnowledge);
  const refreshCapabilitySurface = useAppStore((state) => state.refreshCapabilitySurface);
  const refreshSkills = useAppStore((state) => state.refreshSkills);
  const refreshGenerationGallery = useAppStore((state) => state.refreshGenerationGallery);
  const loadMessageArtifacts = useAppStore((state) => state.loadMessageArtifacts);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const toggleSettingsDrawer = useAppStore((state) => state.toggleSettingsDrawer);
  const toggleQueueDrawer = useAppStore((state) => state.toggleQueueDrawer);
  const toggleGalleryDrawer = useAppStore((state) => state.toggleGalleryDrawer);
  const togglePlanDrawer = useAppStore((state) => state.togglePlanDrawer);
  const toggleAgentsDrawer = useAppStore((state) => state.toggleAgentsDrawer);
  const toggleSkillsDrawer = useAppStore((state) => state.toggleSkillsDrawer);
  const planDrawerOpen = useAppStore((state) => state.planDrawerOpen);
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const setSelectedModel = useAppStore((state) => state.setSelectedModel);
  const setSelectedThinkMode = useAppStore((state) => state.setSelectedThinkMode);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const createSkill = useAppStore((state) => state.createSkill);
  const updateSkill = useAppStore((state) => state.updateSkill);
  const deleteSkill = useAppStore((state) => state.deleteSkill);
  const grantCapabilityPermission = useAppStore(
    (state) => state.grantCapabilityPermission
  );
  const revokeCapabilityPermission = useAppStore(
    (state) => state.revokeCapabilityPermission
  );
  const inspectImageGenerationModels = useAppStore(
    (state) => state.inspectImageGenerationModels
  );
  const startImageGeneration = useAppStore((state) => state.startImageGeneration);
  const startVideoGeneration = useAppStore((state) => state.startVideoGeneration);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const confirmGenerationSelection = useAppStore(
    (state) => state.confirmGenerationSelection
  );
  const dismissGenerationConfirmation = useAppStore(
    (state) => state.dismissGenerationConfirmation
  );
  const editMessageAndResend = useAppStore((state) => state.editMessageAndResend);
  const regenerateResponse = useAppStore((state) => state.regenerateResponse);
  const cancelChatTurn = useAppStore((state) => state.cancelChatTurn);
  const deleteConversation = useAppStore((state) => state.deleteConversation);
  const pinMessage = useAppStore((state) => state.pinMessage);
  const importWorkspaceKnowledge = useAppStore((state) => state.importWorkspaceKnowledge);
  const cancelGenerationJob = useAppStore((state) => state.cancelGenerationJob);
  const retryGenerationJob = useAppStore((state) => state.retryGenerationJob);
  const deleteGenerationArtifact = useAppStore(
    (state) => state.deleteGenerationArtifact
  );

  const activeMessages =
    activeConversationId === null
      ? []
      : messagesByConversation[activeConversationId] ?? [];
  const activeMessagesSignature = useMemo(
    () =>
      activeMessages
        .map((m) => `${m.id}:${m.status}:${m.content.length}:${m.updatedAt}`)
        .join('|'),
    [activeMessages]
  );
  const wireframeDesignIterations = useMemo(
    () =>
      activeMessages.flatMap((message) => {
        if (message.role !== 'assistant') {
          return [];
        }

        return parseWireframeArtifacts(message.content).flatMap((artifact, artifactIndex) =>
          artifact.type === 'design'
            ? [
                {
                  id: `${message.id}:${artifactIndex}`,
                  design: artifact,
                  createdAt: message.createdAt,
                  sourceMessageId: message.id
                }
              ]
            : []
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMessagesSignature]
  );
  const selectedWireframeIterationId =
    activeConversationId === null
      ? null
      : selectedWireframeIterationIds.get(activeConversationId) ?? null;
  const selectedWireframeIteration =
    wireframeDesignIterations.find(
      (iteration) => iteration.id === selectedWireframeIterationId
    ) ??
    wireframeDesignIterations.at(-1) ??
    null;
  const latestWireframeQuestionsMessageId = useMemo(
    () =>
      [...activeMessages]
        .reverse()
        .find((message) => {
          if (message.role !== 'assistant') {
            return false;
          }

          return parseWireframeArtifact(message.content)?.type === 'questions';
        })?.id ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMessagesSignature]
  );
  const activeConversationHasWireframeArtifacts = useMemo(
    () =>
      activeMessages.some(
        (message) =>
          (message.role === 'assistant' &&
            parseWireframeArtifact(message.content) !== null) ||
          message.routeTrace?.reason === 'wireframe-mode'
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMessagesSignature]
  );
  const activeConversationWireframeDisabled =
    activeConversationId !== null && wireframeDisabledConversationIds.has(activeConversationId);
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId
  );
  const activeStreamingAssistantMessageId =
    [...activeMessages]
      .reverse()
      .find((message) => streamingAssistantIds.includes(message.id) && message.role === 'assistant')
      ?.id ?? null;
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeTextBackend = settings?.textInferenceBackend ?? systemStatus?.activeTextBackend ?? 'ollama';
  const availableModels = useMemo(
    () =>
      activeTextBackend === 'nvidia'
        ? systemStatus?.nvidia.models.map((model) => model.name) ?? []
        : systemStatus?.ollama.models.map((model) => model.name) ?? [],
    [activeTextBackend, systemStatus]
  );
  const knowledgeDocuments =
    activeWorkspaceId === null
      ? []
      : knowledgeDocumentsByWorkspace[activeWorkspaceId] ?? [];
  const streaming = streamingAssistantIds.length > 0;
  const textBackendReady =
    activeTextBackend === 'nvidia'
      ? (systemStatus?.nvidia.configured ?? false)
      : (systemStatus?.ollama.reachable ?? false);
  const imageGenerationAvailable = Boolean(settings) && Boolean(systemStatus?.python.reachable);
  const hasExplicitVideoGenerationPair = Boolean(
    settings?.videoGenerationHighNoiseModel && settings?.videoGenerationLowNoiseModel
  );
  const videoGenerationAvailable =
    Boolean(systemStatus?.python.reachable) &&
    (hasExplicitVideoGenerationPair || Boolean(settings?.videoGenerationModel));
  const imageGenerationModelLabel = getImageGenerationModelLabel(
    settings?.imageGenerationModel,
    imageGenerationModelCatalog
  );
  const videoGenerationHighNoiseModelLabel = getImageGenerationModelLabel(
    settings?.videoGenerationHighNoiseModel,
    imageGenerationModelCatalog
  );
  const videoGenerationLowNoiseModelLabel = getImageGenerationModelLabel(
    settings?.videoGenerationLowNoiseModel,
    imageGenerationModelCatalog
  );
  const legacyVideoGenerationModelLabel = getImageGenerationModelLabel(
    settings?.videoGenerationModel,
    imageGenerationModelCatalog
  );
  const videoGenerationModelLabel =
    videoGenerationHighNoiseModelLabel && videoGenerationLowNoiseModelLabel
      ? `High: ${videoGenerationHighNoiseModelLabel} | Low: ${videoGenerationLowNoiseModelLabel}`
      : legacyVideoGenerationModelLabel;
  const submitFeedback = getSubmitFeedback(submitPhase);
  const submitInFlight = submitPhase !== null;
  const submitBlockedByConfirmation =
    pendingGenerationConfirmation !== null &&
    composerMode === 'chat' &&
    editingMessageId === null &&
    !submitInFlight;
  const selectedImageGenerationModelOption =
    imageGenerationModelCatalog?.options.find(
      (option) => option.id === settings?.imageGenerationModel
    ) ??
    getConfiguredImageGenerationModelOption(settings?.imageGenerationModel ?? null);
  const visibleGenerationJobs = useMemo(
    () =>
      generationJobs
        .filter((job) => job.conversationId === (activeConversationId ?? null))
        .sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        ),
    [activeConversationId, generationJobs]
  );
  const cancelTargetAssistantMessageId =
    activeStreamingAssistantMessageId ?? streamingAssistantIds[0] ?? null;

  useEffect(() => {
    const root = document.documentElement;
    const requestedTheme = settings?.theme ?? 'system';
    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    const applyTheme = () => {
      const resolvedTheme = resolveTheme(requestedTheme, mediaQuery?.matches ?? true);
      root.dataset.theme = resolvedTheme;
      root.dataset.themePreference = requestedTheme;
      root.style.colorScheme = resolvedTheme;
    };

    applyTheme();

    if (requestedTheme !== 'system' || !mediaQuery) {
      return undefined;
    }

    const handleThemeChange = () => applyTheme();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleThemeChange);
      return () => mediaQuery.removeEventListener('change', handleThemeChange);
    }

    mediaQuery.addListener(handleThemeChange);
    return () => mediaQuery.removeListener(handleThemeChange);
  }, [settings?.theme]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    if (knowledgeDocumentsByWorkspace[activeWorkspaceId] !== undefined) {
      return;
    }

    void refreshWorkspaceKnowledge(activeWorkspaceId);
  }, [activeWorkspaceId, knowledgeDocumentsByWorkspace, refreshWorkspaceKnowledge]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && sidebarOpen) {
        toggleSidebar(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, toggleSidebar]);

  useEffect(() => {
    if (!agentsDrawerOpen) {
      return;
    }

    void refreshCapabilitySurface();
  }, [agentsDrawerOpen, refreshCapabilitySurface]);

  useEffect(() => {
    if (!skillsDrawerOpen) {
      return;
    }

    void refreshSkills();
  }, [refreshSkills, skillsDrawerOpen]);

  useEffect(() => {
    if (!galleryDrawerOpen) {
      return;
    }

    void refreshGenerationGallery();
    const refreshHandle = window.setInterval(() => {
      void refreshGenerationGallery();
    }, 3_000);

    return () => window.clearInterval(refreshHandle);
  }, [galleryDrawerOpen, refreshGenerationGallery]);

  useEffect(() => {
    if (
      activeConversationId === null ||
      !activeConversationHasWireframeArtifacts ||
      activeConversationWireframeDisabled
    ) {
      return;
    }

    setWireframeConversationIds((current) => {
      if (current.has(activeConversationId)) {
        return current;
      }

      const next = new Set(current);
      next.add(activeConversationId);
      return next;
    });
    setComposerMode((current) =>
      current === 'image' || current === 'video' ? current : 'wireframe'
    );
  }, [
    activeConversationHasWireframeArtifacts,
    activeConversationId,
    activeConversationWireframeDisabled
  ]);

  useEffect(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }

    if (!activeConversationId) {
      loadedDraftConversationRef.current = null;
      setComposerDraft('');
      return;
    }

    const desktop = window.ollamaDesktop;
    if (!desktop) {
      loadedDraftConversationRef.current = activeConversationId;
      return;
    }

    const conversationId = activeConversationId;
    let cancelled = false;
    desktop.chat
      .getComposerDraft(conversationId)
      .then((draft) => {
        if (cancelled) return;
        loadedDraftConversationRef.current = conversationId;
        setComposerDraft(draft ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        loadedDraftConversationRef.current = conversationId;
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  function persistComposerDraft(conversationId: string, prompt: string) {
    const desktop = window.ollamaDesktop;
    if (!desktop) {
      return;
    }
    if (prompt.length === 0) {
      desktop.chat.clearComposerDraft(conversationId).catch(() => undefined);
      return;
    }
    desktop.chat
      .setComposerDraft({ conversationId, prompt })
      .catch(() => undefined);
  }

  function resetComposer(options: { preserveMode?: boolean } = {}) {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    const conversationId = activeConversationId;
    if (conversationId && loadedDraftConversationRef.current === conversationId) {
      persistComposerDraft(conversationId, '');
    }
    setComposerDraft('');
    setComposerAttachments([]);
    if (!options.preserveMode) {
      setComposerMode('chat');
    }
    setEditingMessageId(null);
    dismissGenerationConfirmation();
  }

  function markWireframeConversation(conversationId: string | null) {
    if (!conversationId) {
      return;
    }

    setWireframeConversationIds((current) => {
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
    setWireframeDisabledConversationIds((current) => {
      if (!current.has(conversationId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }

  function handleSelectWireframeIteration(iterationId: string) {
    if (!activeConversationId || !iterationId) {
      return;
    }

    setSelectedWireframeIterationIds((current) => {
      if (current.get(activeConversationId) === iterationId) {
        return current;
      }

      const next = new Map(current);
      next.set(activeConversationId, iterationId);
      return next;
    });
  }

  function buildWireframePromptForSelectedIteration(prompt: string) {
    const trimmedPrompt = prompt.trim();

    if (!selectedWireframeIteration) {
      return trimmedPrompt;
    }

    return [
      'Wireframe revision target:',
      '- Apply this request to the currently loaded design version only.',
      '- Treat earlier wireframe versions as immutable history.',
      '- Create a new design iteration derived from the selected version.',
      '',
      'Selected loaded version:',
      JSON.stringify(selectedWireframeIteration.design),
      '',
      'User request:',
      trimmedPrompt
    ].join('\n');
  }

  function resolveWireframeModeForConversation(conversationId: string | null): ComposerMode {
    if (!conversationId) {
      return 'chat';
    }

    return wireframeConversationIds.has(conversationId) &&
      !wireframeDisabledConversationIds.has(conversationId)
      ? 'wireframe'
      : 'chat';
  }

  function resetComposerForConversation(conversationId: string | null) {
    resetComposer();
    setComposerMode(resolveWireframeModeForConversation(conversationId));
  }

  function handleComposerDraftChange(nextPrompt: string) {
    setComposerDraft(nextPrompt);
    dismissGenerationConfirmation();

    const conversationId = activeConversationId;
    if (!conversationId || loadedDraftConversationRef.current !== conversationId) {
      return;
    }
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = setTimeout(() => {
      persistComposerDraft(conversationId, nextPrompt);
    }, 400);
  }

  function updateComposerAttachments(
    updater: (current: MessageAttachment[]) => MessageAttachment[]
  ) {
    setComposerAttachments((current) => updater(current));
    dismissGenerationConfirmation();
  }

  async function handleGenerationConfirmationSelection(
    selection: 'image' | 'video' | 'chat'
  ) {
    if (submitLockRef.current) {
      return;
    }

    const nextSubmitPhase: SubmitPhase =
      selection === 'image'
        ? 'image'
        : selection === 'video'
          ? 'video'
          : 'chat';

    submitLockRef.current = true;
    setSubmitPhase(nextSubmitPhase);

    try {
      setSubmissionError(null);
      await confirmGenerationSelection(selection);
      resetComposer({ preserveMode: composerMode === 'wireframe' });
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to continue with the selected action.'
      );
    } finally {
      submitLockRef.current = false;
      setSubmitPhase(null);
    }
  }

  function toggleWorkspaceCreator() {
    setCreatingWorkspace((current) => {
      const next = !current;

      if (!next) {
        setWorkspaceDraft('');
        setWorkspaceRootDraft(null);
      }

      return next;
    });
  }

  if (!desktopRuntimeAvailable) {
    return <DesktopOnlyNotice />;
  }

  async function handleSubmit() {
    if (
      submitLockRef.current ||
      (pendingGenerationConfirmation !== null &&
        composerMode === 'chat' &&
        editingMessageId === null)
    ) {
      return;
    }

    const nextSubmitPhase: SubmitPhase =
      editingMessageId
        ? 'edit'
        : composerMode === 'image'
          ? 'image'
          : composerMode === 'video'
            ? 'video'
            : composerMode === 'wireframe'
              ? 'wireframe'
              : 'chat';

    submitLockRef.current = true;
    setSubmitPhase(nextSubmitPhase);

    try {
      setSubmissionError(null);

      if (editingMessageId) {
        await editMessageAndResend(
          editingMessageId,
          composerDraft,
          composerAttachments
        );
      } else if (composerMode === 'image') {
        await startImageGeneration({
          conversationId: activeConversationId ?? undefined,
          workspaceId:
            activeConversationId === null
              ? activeWorkspaceId ?? undefined
              : undefined,
          prompt: composerDraft.trim(),
          mode: composerAttachments.length > 0 ? 'image-to-image' : 'text-to-image',
          workflowProfile:
            selectedImageGenerationModelOption?.family === 'qwen-image-edit'
              ? 'qwen-image-edit-2511'
              : 'default',
          referenceImages: composerAttachments
        });
      } else if (composerMode === 'video') {
        await startVideoGeneration({
          conversationId: activeConversationId ?? undefined,
          workspaceId:
            activeConversationId === null
              ? activeWorkspaceId ?? undefined
              : undefined,
          prompt: composerDraft.trim(),
          model:
            settings?.videoGenerationHighNoiseModel ||
            settings?.videoGenerationModel ||
            undefined,
          highNoiseModel: settings?.videoGenerationHighNoiseModel || undefined,
          lowNoiseModel: settings?.videoGenerationLowNoiseModel || undefined,
          mode: 'image-to-video',
          workflowProfile: 'wan-image-to-video',
          referenceImages: composerAttachments.slice(0, 1)
        });
      } else if (composerMode === 'wireframe') {
        const wireframeMode: ChatRequestMode = 'wireframe';
        const resultKind = await sendPrompt(
          buildWireframePromptForSelectedIteration(composerDraft),
          composerAttachments,
          wireframeMode
        );

        if (resultKind === 'generation-confirmation') {
          return;
        }

        markWireframeConversation(useAppStore.getState().activeConversationId);
      } else {
        const resultKind = await sendPrompt(composerDraft, composerAttachments);

        if (resultKind === 'generation-confirmation') {
          return;
        }
      }

      resetComposer({ preserveMode: composerMode === 'wireframe' });
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to send message.'
      );
    } finally {
      submitLockRef.current = false;
      setSubmitPhase(null);
    }
  }

  async function handleAttachFiles() {
    try {
      setSubmissionError(null);
      const attachments = await getDesktopApi().chat.pickAttachments();
      updateComposerAttachments((current) => mergeAttachments(current, attachments));
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to attach files.'
      );
    }
  }

  async function handleSubmitWireframeAnswers(prompt: string) {
    if (submitLockRef.current || streaming || submitInFlight) {
      return;
    }

    submitLockRef.current = true;
    setSubmitPhase('wireframe');

    try {
      setSubmissionError(null);
      await sendPrompt(prompt, [], 'wireframe');
      markWireframeConversation(useAppStore.getState().activeConversationId);
      setComposerMode('wireframe');
      setComposerDraft('');
      setComposerAttachments([]);
      dismissGenerationConfirmation();
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to submit wireframe answers.'
      );
    } finally {
      submitLockRef.current = false;
      setSubmitPhase(null);
    }
  }

  function handleToggleWireframeMode() {
    setSubmissionError(null);
    setEditingMessageId(null);
    dismissGenerationConfirmation();
    setComposerMode((current) => {
      const nextMode = current === 'wireframe' ? 'chat' : 'wireframe';

      if (activeConversationId) {
        if (nextMode === 'wireframe') {
          markWireframeConversation(activeConversationId);
        } else {
          setWireframeConversationIds((ids) => {
            const next = new Set(ids);
            next.delete(activeConversationId);
            return next;
          });
          setWireframeDisabledConversationIds((ids) => {
            const next = new Set(ids);
            next.add(activeConversationId);
            return next;
          });
        }
      }

      return nextMode;
    });
  }

  function handleEditMessage(message: StoredMessage) {
    setSubmissionError(null);
    setEditingMessageId(message.id);
    setComposerDraft(message.content);
    setComposerAttachments(message.attachments);
    setComposerMode('chat');
    dismissGenerationConfirmation();
  }

  async function handleRegenerateMessage(message: StoredMessage) {
    try {
      setSubmissionError(null);
      await regenerateResponse(message.id);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to regenerate response.'
      );
    }
  }

  async function handleCancelStreamingTurn() {
    if (!cancelTargetAssistantMessageId) {
      return;
    }

    try {
      setSubmissionError(null);
      await cancelChatTurn(cancelTargetAssistantMessageId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to stop the current reply.'
      );
    }
  }

  async function handleTogglePinned(message: StoredMessage, pinned: boolean) {
    try {
      setSubmissionError(null);
      await pinMessage(message.id, pinned);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to update pinned memory.'
      );
    }
  }

  async function handleCancelGenerationJob(jobId: string) {
    try {
      setSubmissionError(null);
      await cancelGenerationJob(jobId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to cancel the generation job.'
      );
    }
  }

  async function handleRetryGenerationJob(jobId: string) {
    try {
      setSubmissionError(null);
      await retryGenerationJob(jobId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to retry the generation job.'
      );
    }
  }

  async function handleDeleteGenerationArtifact(artifactId: string) {
    try {
      setSubmissionError(null);
      await deleteGenerationArtifact(artifactId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to delete the generated media.'
      );
      throw error;
    }
  }

  function handleEditGeneratedImage(item: GenerationGalleryItem) {
    setSubmissionError(null);
    setEditingMessageId(null);
    setComposerDraft(item.prompt ?? '');
    setComposerAttachments([createGeneratedMediaAttachment(item)]);
    setComposerMode('image');
    dismissGenerationConfirmation();
    toggleGalleryDrawer(false);
  }

  function handleCreateVideoFromGeneratedImage(item: GenerationGalleryItem) {
    setSubmissionError(null);
    setEditingMessageId(null);
    setComposerDraft(item.prompt ?? '');
    setComposerAttachments([createGeneratedMediaAttachment(item)]);
    setComposerMode('video');
    dismissGenerationConfirmation();
    toggleGalleryDrawer(false);
  }

  async function handleImportKnowledge() {
    try {
      setSubmissionError(null);
      await importWorkspaceKnowledge();
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to import workspace knowledge.'
      );
    }
  }

  async function handleCreateWorkspace() {
    const trimmedName = workspaceDraft.trim();
    const rootPath = workspaceRootDraft?.trim() ?? '';

    if (!trimmedName || !rootPath) {
      return;
    }

    try {
      setSubmissionError(null);
      await createWorkspace({ name: trimmedName, rootPath });
      setWorkspaceDraft('');
      setWorkspaceRootDraft(null);
      setCreatingWorkspace(false);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to create workspace.'
      );
    }
  }

  async function handlePickWorkspaceRoot() {
    try {
      setSubmissionError(null);
      const rootPath = await pickWorkspaceDirectory();

      if (!rootPath) {
        return;
      }

      setWorkspaceRootDraft(rootPath);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to select workspace folder.'
      );
    }
  }

  async function handleSetWorkspaceFolder(workspaceId: string) {
    try {
      setSubmissionError(null);
      const rootPath = await pickWorkspaceDirectory();

      if (!rootPath) {
        return;
      }

      await updateWorkspaceRoot(workspaceId, rootPath);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to connect workspace folder.'
      );
    }
  }

  async function handleClearWorkspaceFolder(workspaceId: string) {
    try {
      setSubmissionError(null);
      await updateWorkspaceRoot(workspaceId, null);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to disconnect workspace folder.'
      );
    }
  }

  async function handleTextBackendChange(nextBackend: 'ollama' | 'nvidia') {
    try {
      setSubmissionError(null);
      await updateSettings({ textInferenceBackend: nextBackend });
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to update the text backend.'
      );
    }
  }

  async function handleCreateSkill(input: {
    title: string;
    description: string;
    prompt: string;
  }) {
    try {
      setSubmissionError(null);
      await createSkill(input);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to create skill.'
      );
      throw error;
    }
  }

  async function handleUpdateSkill(input: {
    skillId: string;
    title: string;
    description: string;
    prompt: string;
  }) {
    try {
      setSubmissionError(null);
      await updateSkill(input);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to update skill.'
      );
      throw error;
    }
  }

  async function handleDeleteSkill(skillId: string) {
    try {
      setSubmissionError(null);
      await deleteSkill({ skillId });
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to delete skill.'
      );
      throw error;
    }
  }

  return (
    <div className="motion-app-shell relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <TitleBar />
      <div className="motion-ambient pointer-events-none absolute inset-0" />

      <div className="relative flex h-[calc(100vh-2.5rem)] flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Inline sidebar — always visible at lg+ */}
          <div
            className="hidden h-full lg:block"
            data-mascot-target="sidebar"
          >
            <Sidebar
              activeWorkspaceId={activeWorkspaceId}
              activeConversationId={activeConversationId}
              conversations={conversations}
              onSearchQueryChange={(query) => void setSearchQuery(query)}
              onSelectConversation={(conversationId) => {
                resetComposerForConversation(conversationId);
                void selectConversation(conversationId);
              }}
              onSelectWorkspace={(workspaceId) => {
                resetComposer();
                void selectWorkspace(workspaceId);
              }}
              onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
              onSetWorkspaceFolder={(workspaceId) => {
                void handleSetWorkspaceFolder(workspaceId);
              }}
              onClearWorkspaceFolder={(workspaceId) => {
                void handleClearWorkspaceFolder(workspaceId);
              }}
              onNewChat={() => {
                resetComposerForConversation(null);
                void selectConversation(null);
              }}
              onNewWorkspace={toggleWorkspaceCreator}
              onDeleteConversation={(conversationId) => {
                void deleteConversation(conversationId);
              }}
              searchQuery={searchQuery}
              searchResults={searchResults}
              workspaces={workspaces}
            />
          </div>

          {/* Overlay sidebar — visible when sidebarOpen on smaller screens */}
          {sidebarOpen && (
            <>
              <div
                className="fixed inset-0 z-20 animate-fade-in bg-slate-950/50 backdrop-blur-sm lg:hidden"
                onClick={() => toggleSidebar(false)}
                role="presentation"
              />
              <aside className="fixed bottom-0 left-0 top-10 z-30 w-80 animate-slide-in-left lg:hidden">
                <Sidebar
                  overlayMode
                  onClose={() => toggleSidebar(false)}
                  activeWorkspaceId={activeWorkspaceId}
                  activeConversationId={activeConversationId}
                  conversations={conversations}
                  onSearchQueryChange={(query) => void setSearchQuery(query)}
                  onSelectConversation={(conversationId) => {
                    resetComposerForConversation(conversationId);
                    void selectConversation(conversationId);
                    toggleSidebar(false);
                  }}
                  onSelectWorkspace={(workspaceId) => {
                    resetComposer();
                    void selectWorkspace(workspaceId);
                    toggleSidebar(false);
                  }}
                  onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
                  onSetWorkspaceFolder={(workspaceId) => {
                    void handleSetWorkspaceFolder(workspaceId);
                  }}
                  onClearWorkspaceFolder={(workspaceId) => {
                    void handleClearWorkspaceFolder(workspaceId);
                  }}
                  onNewChat={() => {
                    resetComposerForConversation(null);
                    void selectConversation(null);
                  }}
                  onNewWorkspace={toggleWorkspaceCreator}
                  onDeleteConversation={(conversationId) => {
                    void deleteConversation(conversationId);
                  }}
                  searchQuery={searchQuery}
                  searchResults={searchResults}
                  workspaces={workspaces}
                />
              </aside>
            </>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            {!initialized ? (
              <div className="flex flex-1 items-center justify-center px-6 text-sm text-slate-400">
                <div
                  aria-live="polite"
                  className="motion-panel motion-loader-sweep rounded-[1.75rem] border border-cyan-300/15 bg-slate-900/70 px-6 py-5 text-cyan-50 shadow-panel"
                  role="status"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-cyan-200/25 border-t-cyan-200 motion-reduce:animate-none motion-safe:animate-spin"
                    />
                    <div>
                      <p className="motion-text-reveal text-xs uppercase tracking-[0.24em] text-cyan-100/70">
                        Starting runtime
                      </p>
                      <p className="motion-text-reveal-delayed mt-2 text-sm text-slate-300">
                        Bootstrapping Electron, SQLite, Ollama health checks, and the Python server
                        <span className="motion-ellipsis" />
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : bootstrapError ? (
              <div className="motion-panel m-6 rounded-[2rem] border border-rose-400/20 bg-rose-500/10 p-6 text-sm text-rose-100 shadow-panel">
                {bootstrapError}
              </div>
            ) : (
              <>
                {creatingWorkspace ? (
                  <section className="motion-panel border-b border-white/10 px-6 py-4">
                    <div className="motion-focus-ring mx-auto flex max-w-[88rem] flex-wrap items-end gap-3 rounded-[1.75rem] border border-white/10 bg-slate-900/55 px-5 py-4 shadow-panel">
                      <div className="min-w-[18rem] flex-1">
                        <label
                          className="sr-only"
                          htmlFor="chat-workspace-name"
                        >
                          Workspace name
                        </label>
                        <input
                          id="chat-workspace-name"
                          className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                          onChange={(event) => setWorkspaceDraft(event.target.value)}
                          placeholder="Workspace name"
                          value={workspaceDraft}
                        />
                      </div>
                      <div className="min-w-[18rem] flex-1">
                        <label
                          className="sr-only"
                          htmlFor="chat-workspace-root"
                        >
                          Workspace folder
                        </label>
                        <button
                          aria-label="Workspace folder"
                          className="motion-interactive flex w-full items-center justify-between rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-left text-sm text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                          id="chat-workspace-root"
                          onClick={() => {
                            void handlePickWorkspaceRoot();
                          }}
                          type="button"
                        >
                          <span className="truncate text-slate-100">
                            {workspaceRootDraft ?? 'Select workspace folder'}
                          </span>
                          <span className="ml-3 shrink-0 text-xs uppercase tracking-[0.16em] text-cyan-200/70">
                            Browse
                          </span>
                        </button>
                      </div>
                      <button
                        className="motion-interactive rounded-2xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        onClick={() => {
                          setWorkspaceDraft('');
                          setWorkspaceRootDraft(null);
                          setCreatingWorkspace(false);
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="motion-interactive rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                        disabled={!workspaceDraft.trim() || !workspaceRootDraft}
                        onClick={() => {
                          void handleCreateWorkspace();
                        }}
                        type="button"
                      >
                        Create workspace
                      </button>
                    </div>
                  </section>
                ) : null}

                <MessageList
                  conversationTitle={activeConversation?.title ?? 'New conversation'}
                  generationJobs={visibleGenerationJobs}
                  messages={activeMessages}
                  pendingHint={submitFeedback?.transcriptHint ?? null}
                  pendingLabel={submitFeedback?.transcriptLabel ?? null}
                  onCancelGenerationJob={(jobId) => {
                    void handleCancelGenerationJob(jobId);
                  }}
                  onRetryGenerationJob={(jobId) => {
                    void handleRetryGenerationJob(jobId);
                  }}
                  onEditMessage={handleEditMessage}
                  onLoadMessageArtifacts={(messageId) => {
                    void loadMessageArtifacts(messageId);
                  }}
                  onTogglePin={(message, pinned) => {
                    void handleTogglePinned(message, pinned);
                  }}
                  onRegenerateMessage={(message) => {
                    void handleRegenerateMessage(message);
                  }}
                  onSelectWireframeIteration={handleSelectWireframeIteration}
                  onSubmitWireframeAnswers={handleSubmitWireframeAnswers}
                  streaming={streaming}
                  wireframeDesignIterations={wireframeDesignIterations}
                  wireframeSelectedIterationId={selectedWireframeIteration?.id ?? null}
                  wireframeIntroVisible={composerMode === 'wireframe'}
                  wireframeQuestionsMessageId={
                    composerMode === 'wireframe' ? latestWireframeQuestionsMessageId : null
                  }
                />

                {pendingGenerationConfirmation ? (
                  <section className="motion-panel mx-6 mb-3 rounded-[1.75rem] border border-amber-300/20 bg-amber-500/10 px-4 py-4 shadow-panel">
                    <div className="flex flex-col gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-amber-100/75">
                          Confirm Generation
                        </p>
                        <p className="mt-2 text-sm text-amber-50">
                          This prompt looks like a{' '}
                          {pendingGenerationConfirmation.detectedIntent === 'video'
                            ? 'generation-ready video'
                            : 'generation-ready image'}{' '}
                          request. Choose how to handle it before the bridge starts anything.
                        </p>
                        <p className="mt-2 rounded-2xl border border-white/10 bg-slate-950/45 px-3 py-3 text-sm text-slate-200">
                          {pendingGenerationConfirmation.prompt}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {pendingGenerationConfirmation.options.map((option) => (
                          <button
                            key={option.selection}
                            className={
                              option.recommended
                                ? 'motion-interactive rounded-2xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200'
                                : 'motion-interactive rounded-2xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200'
                            }
                            onClick={() => {
                              void handleGenerationConfirmationSelection(option.selection);
                            }}
                            type="button"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-wrap gap-2 text-xs text-amber-100/75">
                        {pendingGenerationConfirmation.options.map((option) => (
                          <span
                            key={`${option.selection}-description`}
                            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5"
                          >
                            {option.label}: {option.description}
                          </span>
                        ))}
                      </div>
                    </div>
                  </section>
                ) : null}

                {submissionError ? (
                  <div className="motion-panel mx-6 mb-3 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                    {submissionError}
                  </div>
                ) : null}

                <ChatComposer
                  activeWorkspaceName={activeWorkspace?.name ?? null}
                  attachments={composerAttachments}
                  disabled={
                    composerMode === 'image'
                      ? !imageGenerationAvailable || streaming || submitInFlight
                      : composerMode === 'video'
                        ? !videoGenerationAvailable || streaming || submitInFlight
                        : !settings || !textBackendReady || streaming || submitInFlight
                  }
                  submitDisabled={submitBlockedByConfirmation}
                  editing={editingMessageId !== null}
                  generationMode={composerMode}
                  imageGenerationAvailable={imageGenerationAvailable}
                  imageGenerationModelLabel={imageGenerationModelLabel}
                  videoGenerationAvailable={videoGenerationAvailable}
                  videoGenerationModelLabel={videoGenerationModelLabel}
                  knowledgeDocumentCount={knowledgeDocuments.length}
                  onAttach={handleAttachFiles}
                  onCancelEdit={resetComposer}
                  onEnterImageMode={() => {
                    setSubmissionError(null);
                    setEditingMessageId(null);
                    setComposerMode('image');
                    dismissGenerationConfirmation();
                  }}
                  onEnterVideoMode={() => {
                    setSubmissionError(null);
                    setEditingMessageId(null);
                    setComposerMode('video');
                    dismissGenerationConfirmation();
                  }}
                  onExitImageMode={() => {
                    setComposerMode('chat');
                    dismissGenerationConfirmation();
                  }}
                  onExitVideoMode={() => {
                    setComposerMode('chat');
                    dismissGenerationConfirmation();
                  }}
                  onToggleWireframeMode={handleToggleWireframeMode}
                  onImportWorkspaceKnowledge={handleImportKnowledge}
                  onPromptChange={handleComposerDraftChange}
                  onRemoveAttachment={(attachmentId) => {
                    updateComposerAttachments((current) =>
                      current.filter((attachment) => attachment.id !== attachmentId)
                    );
                  }}
                  onSubmit={handleSubmit}
                  prompt={composerDraft}
                  submitHint={submitFeedback?.hint ?? null}
                  submitLabel={submitFeedback?.label ?? null}
                  submitting={submitInFlight}
                  streaming={streaming}
                  workspaceActionsEnabled={activeWorkspaceId !== null && !submitInFlight}
                  workspaceRootPath={activeWorkspace?.rootPath ?? null}
                  {...(cancelTargetAssistantMessageId
                    ? { onStop: handleCancelStreamingTurn }
                    : {})}
                />
              </>
            )}
          </div>
        </div>

        <StatusBar
          activeTextBackend={activeTextBackend}
          availableModels={availableModels}
          onOpenAgents={() => toggleAgentsDrawer()}
          onOpenGallery={() => toggleGalleryDrawer()}
          onOpenPlan={() => togglePlanDrawer()}
          onOpenQueue={() => toggleQueueDrawer()}
          onOpenSkills={() => toggleSkillsDrawer()}
          onOpenSettings={() => toggleSettingsDrawer(true)}
          agentsOpen={agentsDrawerOpen}
          galleryOpen={galleryDrawerOpen}
          onSelectedModelChange={setSelectedModel}
          onSelectedThinkModeChange={(value) => setSelectedThinkMode(value as '' | 'off' | 'on' | 'low' | 'medium' | 'high')}
          onTextBackendChange={(backend) => void handleTextBackendChange(backend)}
          planOpen={planDrawerOpen}
          queueOpen={queueDrawerOpen}
          skillsOpen={skillsDrawerOpen}
          selectedModel={selectedModel}
          selectedThinkMode={selectedThinkMode}
          settingsOpen={settingsDrawerOpen}
          systemStatus={systemStatus}
          thinkModeDisabled={activeTextBackend !== 'ollama'}
        />
      </div>

      <SettingsDrawer
        key={
          settings
            ? `${settings.textInferenceBackend}-${settings.ollamaBaseUrl}-${settings.nvidiaBaseUrl}-${settings.defaultModel}-${settings.codingModel}-${settings.visionModel}-${settings.imageGenerationModel}-${settings.additionalModelsDirectory ?? 'none'}-${settings.videoGenerationModel}-${settings.videoGenerationHighNoiseModel}-${settings.videoGenerationLowNoiseModel}-${settings.pythonPort}-${String(settings.streamingMascotEnabled)}-${String(settings.notificationsEnabled)}-${settings.theme}-${String(settingsDrawerOpen)}`
            : 'settings-empty'
        }
        capabilities={availableTools}
        capabilityAgents={capabilityAgents}
        capabilityAuditEvents={capabilityAuditEvents}
        capabilityPermissions={capabilityPermissions}
        capabilityPlanState={capabilityPlanState}
        capabilitySchedules={capabilitySchedules}
        capabilityTasks={capabilityTasks}
        capabilityTeams={capabilityTeams}
        capabilityWorktrees={capabilityWorktrees}
        imageGenerationModelCatalog={imageGenerationModelCatalog}
        nvidiaModels={systemStatus?.nvidia.models.map((model) => model.name) ?? []}
        ollamaModels={systemStatus?.ollama.models.map((model) => model.name) ?? []}
        onClose={() => toggleSettingsDrawer(false)}
        onDiscoverImageModels={inspectImageGenerationModels}
        onGrantCapabilityPermission={grantCapabilityPermission}
        onPickAdditionalModelsDirectory={async () =>
          (await getDesktopApi().settings.pickAdditionalModelsDirectory()).path
        }
        onRevokeCapabilityPermission={revokeCapabilityPermission}
        onSave={updateSettings}
        open={settingsDrawerOpen}
        settings={settings}
      />

      <QueueDrawer
        generationJobs={generationJobs}
        onCancelGenerationJob={(jobId) => {
          void handleCancelGenerationJob(jobId);
        }}
        onClose={() => toggleQueueDrawer()}
        onRetryGenerationJob={(jobId) => {
          void handleRetryGenerationJob(jobId);
        }}
        open={queueDrawerOpen}
        pendingRequestCount={systemStatus?.pendingRequestCount ?? 0}
      />

      <GalleryDrawer
        galleryItems={generationGalleryItems}
        onCreateVideoFromImage={handleCreateVideoFromGeneratedImage}
        onClose={() => toggleGalleryDrawer()}
        onDeleteArtifact={(artifactId) => handleDeleteGenerationArtifact(artifactId)}
        onEditImage={handleEditGeneratedImage}
        open={galleryDrawerOpen}
      />

      <PlanDrawer
        onClose={() => togglePlanDrawer()}
        onDeleteTask={(taskId) => {
          void useAppStore.getState().deleteTask(taskId);
        }}
        open={planDrawerOpen}
        planState={capabilityPlanState}
        tasks={capabilityTasks}
      />

      <AgentsDrawer
        agents={capabilityAgents}
        onClose={() => toggleAgentsDrawer(false)}
        open={agentsDrawerOpen}
        teams={capabilityTeams}
      />

      <SkillsDrawer
        onClose={() => toggleSkillsDrawer(false)}
        onCreateSkill={(input) => handleCreateSkill(input)}
        onDeleteSkill={(skillId) => handleDeleteSkill(skillId)}
        onUpdateSkill={(input) => handleUpdateSkill(input)}
        open={skillsDrawerOpen}
        skills={availableSkills}
      />

      <StreamingMascot active={streaming && (settings?.streamingMascotEnabled ?? true)} />
    </div>
  );
}
