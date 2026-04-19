import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type MessageAttachment,
  type StoredMessage
} from '@bridge/ipc/contracts';
import { AgentsDrawer } from '@renderer/components/agents-drawer';
import { ChatComposer } from '@renderer/components/chat-composer';
import { DesktopOnlyNotice } from '@renderer/components/desktop-only-notice';
import { MessageList } from '@renderer/components/message-list';
import { PlanDrawer } from '@renderer/components/plan-drawer';
import { QueueDrawer } from '@renderer/components/queue-drawer';
import { SkillsDrawer } from '@renderer/components/skills-drawer';
import { SettingsDrawer } from '@renderer/components/settings-drawer';
import { Sidebar } from '@renderer/components/sidebar';
import { StatusBar } from '@renderer/components/status-bar';
import { TitleBar } from '@renderer/components/title-bar';
import { useAppBootstrap } from '@renderer/hooks/use-app-bootstrap';
import { getDesktopApi, hasDesktopApi } from '@renderer/lib/api';
import {
  getConfiguredImageGenerationModelOption,
  getImageGenerationModelLabel
} from '@renderer/lib/image-generation-models';
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

type SubmitPhase = 'chat' | 'image' | 'edit';

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

export function ChatPage() {
  useAppBootstrap();
  const desktopRuntimeAvailable = hasDesktopApi();

  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<MessageAttachment[]>([]);
  const [composerMode, setComposerMode] = useState<'chat' | 'image'>('chat');
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
  const selectedModel = useAppStore((state) => state.selectedModel);
  const selectedThinkMode = useAppStore((state) => state.selectedThinkMode);
  const settingsDrawerOpen = useAppStore((state) => state.settingsDrawerOpen);
  const queueDrawerOpen = useAppStore((state) => state.queueDrawerOpen);
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
  const loadMessageArtifacts = useAppStore((state) => state.loadMessageArtifacts);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const toggleSettingsDrawer = useAppStore((state) => state.toggleSettingsDrawer);
  const toggleQueueDrawer = useAppStore((state) => state.toggleQueueDrawer);
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
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const editMessageAndResend = useAppStore((state) => state.editMessageAndResend);
  const regenerateResponse = useAppStore((state) => state.regenerateResponse);
  const cancelChatTurn = useAppStore((state) => state.cancelChatTurn);
  const deleteConversation = useAppStore((state) => state.deleteConversation);
  const pinMessage = useAppStore((state) => state.pinMessage);
  const importWorkspaceKnowledge = useAppStore((state) => state.importWorkspaceKnowledge);
  const cancelGenerationJob = useAppStore((state) => state.cancelGenerationJob);
  const retryGenerationJob = useAppStore((state) => state.retryGenerationJob);

  const activeMessages =
    activeConversationId === null
      ? []
      : messagesByConversation[activeConversationId] ?? [];
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
  const imageGenerationModelLabel = getImageGenerationModelLabel(
    settings?.imageGenerationModel,
    imageGenerationModelCatalog
  );
  const submitFeedback = getSubmitFeedback(submitPhase);
  const submitInFlight = submitPhase !== null;
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
  const headerEyebrow = activeWorkspace ? 'Workspace' : 'Local chat';
  const headerTitle = activeWorkspace?.name ?? 'General';
  const headerSubtitle = activeConversation
    ? `Active chat: ${activeConversation.title}`
    : 'Start a new conversation or import workspace knowledge to ground the next turn.';

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

  function resetComposer() {
    setComposerDraft('');
    setComposerAttachments([]);
    setComposerMode('chat');
    setEditingMessageId(null);
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
    if (submitLockRef.current) {
      return;
    }

    const nextSubmitPhase: SubmitPhase =
      editingMessageId ? 'edit' : composerMode === 'image' ? 'image' : 'chat';

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
      } else {
        await sendPrompt(composerDraft, composerAttachments);
      }

      resetComposer();
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
      setComposerAttachments((current) => mergeAttachments(current, attachments));
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to attach files.'
      );
    }
  }

  function handleEditMessage(message: StoredMessage) {
    setSubmissionError(null);
    setEditingMessageId(message.id);
    setComposerDraft(message.content);
    setComposerAttachments(message.attachments);
    setComposerMode('chat');
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

  async function handleDeleteConversation() {
    if (!activeConversation || streaming) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${activeConversation.title}"? This removes the conversation and its messages from local storage.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setSubmissionError(null);
      resetComposer();
      await deleteConversation(activeConversation.id);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to delete conversation.'
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
        error instanceof Error ? error.message : 'Unable to cancel the image job.'
      );
    }
  }

  async function handleRetryGenerationJob(jobId: string) {
    try {
      setSubmissionError(null);
      await retryGenerationJob(jobId);
    } catch (error) {
      setSubmissionError(
        error instanceof Error ? error.message : 'Unable to retry the image job.'
      );
    }
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
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <TitleBar />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(45,212,191,0.18),_transparent_40%),radial-gradient(circle_at_top_right,_rgba(249,115,22,0.16),_transparent_30%)]" />

      <div className="relative flex h-[calc(100vh-2.5rem)] flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Inline sidebar — always visible at lg+ */}
          <div className="hidden h-full lg:block">
            <Sidebar
              activeWorkspaceId={activeWorkspaceId}
              activeConversationId={activeConversationId}
              conversations={conversations}
              onSearchQueryChange={(query) => void setSearchQuery(query)}
              onSelectConversation={(conversationId) => {
                resetComposer();
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
                resetComposer();
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
                className="fixed inset-0 z-20 bg-slate-950/50 backdrop-blur-sm animate-fade-in lg:hidden"
                onClick={() => toggleSidebar(false)}
                role="presentation"
              />
              <aside className="fixed top-10 bottom-0 left-0 z-30 w-80 animate-slide-in-left lg:hidden">
                <Sidebar
                  overlayMode
                  onClose={() => toggleSidebar(false)}
                  activeWorkspaceId={activeWorkspaceId}
                  activeConversationId={activeConversationId}
                  conversations={conversations}
                  onSearchQueryChange={(query) => void setSearchQuery(query)}
                  onSelectConversation={(conversationId) => {
                    resetComposer();
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
                    resetComposer();
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
            {/* <header className="border-b border-white/10 px-6 py-4">
              <div className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-3">
                <div className="flex items-center gap-3">
                  <button
                    aria-expanded={sidebarOpen}
                    aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                    className="lg:hidden flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    onClick={() => toggleSidebar()}
                    type="button"
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                      <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
                      {headerEyebrow}
                    </p>
                    <h2 className="mt-2 text-[1.95rem] font-semibold leading-none text-white">
                      {headerTitle}
                    </h2>
                    <p
                      className="mt-1 truncate text-sm text-slate-400"
                      title={headerSubtitle}
                    >
                      {headerSubtitle}
                    </p>
                  </div>
                </div>
              </div>
            </header> */}

            {!initialized ? (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Bootstrapping Electron, SQLite, Ollama health checks, and the Python server...
              </div>
            ) : bootstrapError ? (
              <div className="m-6 rounded-[2rem] border border-rose-400/20 bg-rose-500/10 p-6 text-sm text-rose-100 shadow-panel">
                {bootstrapError}
              </div>
            ) : (
              <>
                {creatingWorkspace ? (
                  <section className="border-b border-white/10 px-6 py-4">
                    <div className="mx-auto flex max-w-[88rem] flex-wrap items-end gap-3 rounded-[1.75rem] border border-white/10 bg-slate-900/55 px-5 py-4 shadow-panel">
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
                          className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-left text-sm text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
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
                        className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
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
                        className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
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
                  streaming={streaming}
                />

                {submissionError ? (
                  <div className="mx-6 mb-3 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                    {submissionError}
                  </div>
                ) : null}

                <ChatComposer
                  activeWorkspaceName={activeWorkspace?.name ?? null}
                  attachments={composerAttachments}
                  disabled={
                    composerMode === 'image'
                      ? !imageGenerationAvailable || streaming || submitInFlight
                      : !settings || !textBackendReady || streaming || submitInFlight
                  }
                  editing={editingMessageId !== null}
                  generationMode={composerMode === 'image'}
                  imageGenerationAvailable={imageGenerationAvailable}
                  imageGenerationModelLabel={imageGenerationModelLabel}
                  knowledgeDocumentCount={knowledgeDocuments.length}
                  onAttach={handleAttachFiles}
                  onCancelEdit={resetComposer}
                  onEnterImageMode={() => {
                    setSubmissionError(null);
                    setEditingMessageId(null);
                    setComposerMode('image');
                  }}
                  onExitImageMode={() => {
                    setComposerMode('chat');
                  }}
                  onImportWorkspaceKnowledge={handleImportKnowledge}
                  onPromptChange={setComposerDraft}
                  onRemoveAttachment={(attachmentId) => {
                    setComposerAttachments((current) =>
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
          onOpenPlan={() => togglePlanDrawer()}
          onOpenQueue={() => toggleQueueDrawer()}
          onOpenSkills={() => toggleSkillsDrawer()}
          onOpenSettings={() => toggleSettingsDrawer(true)}
          agentsOpen={agentsDrawerOpen}
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
            ? `${settings.textInferenceBackend}-${settings.ollamaBaseUrl}-${settings.nvidiaBaseUrl}-${settings.defaultModel}-${settings.codingModel}-${settings.visionModel}-${settings.imageGenerationModel}-${settings.additionalModelsDirectory ?? 'none'}-${settings.videoGenerationModel}-${settings.pythonPort}-${settings.theme}-${String(settingsDrawerOpen)}`
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
    </div>
  );
}
