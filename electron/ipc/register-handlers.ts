import { writeFileSync } from 'node:fs';
import { BrowserWindow, Notification, app, dialog, ipcMain, shell } from 'electron';
import type { DesktopAppContext } from '@bridge/app-context';
import {
  agentSessionSchema,
  auditEventRecordSchema,
  type ChatStreamEvent,
  type GenerationJob,
  IpcChannels,
  attachmentPreviewInputSchema,
  attachmentPreviewResultSchema,
  cancelGenerationJobInputSchema,
  cancelChatTurnInputSchema,
  capabilityPermissionInputSchema,
  capabilityPermissionSchema,
  capabilityTaskSchema,
  chatStartAcceptedSchema,
  chatTurnAcceptedSchema,
  chatTurnRequestSchema,
  confirmGenerationIntentInputSchema,
  composerDraftInputSchema,
  conversationIdSchema,
  conversationSearchResultSchema,
  conversationSummarySchema,
  createSkillInputSchema,
  createWorkspaceInputSchema,
  deleteGenerationArtifactInputSchema,
  deleteSkillInputSchema,
  personaDefinitionSchema,
  createPersonaInputSchema,
  updatePersonaInputSchema,
  deletePersonaInputSchema,
  setActivePersonaInputSchema,
  deleteWorkspaceInputSchema,
  deleteConversationInputSchema,
  editMessageInputSchema,
  exportConversationInputSchema,
  exportConversationResultSchema,
  generationGalleryItemSchema,
  generationJobSchema,
  generationStreamEventSchema,
  imageGenerationModelCatalogSchema,
  imageGenerationRequestSchema,
  imageGenerationStartResultSchema,
  videoGenerationRequestSchema,
  videoGenerationStartResultSchema,
  importConversationResultSchema,
  importWorkspaceKnowledgeResultSchema,
  knowledgeDocumentSchema,
    knowledgeDocumentsInputSchema,
    listImageGenerationModelsInputSchema,
    listGenerationJobsInputSchema,
    messageIdSchema,
    messageAttachmentSchema,
  openLocalPathInputSchema,
  pinMessageInputSchema,
  planStateSchema,
  scheduledPromptSchema,
  skillDefinitionSchema,
  retryGenerationJobInputSchema,
  regenerateResponseInputSchema,
  searchConversationsInputSchema,
  storedMessageSchema,
  systemStatusSchema,
  teamSessionSchema,
  toolDefinitionSchema,
  updateSkillInputSchema,
  updateWorkspaceRootInputSchema,
  updateUserSettingsSchema,
  userSettingsSchema,
  worktreeSessionSchema,
  workspaceDirectorySelectionSchema,
  workspaceSummarySchema,
  lastSessionSchema
} from '@bridge/ipc/contracts';

const ALLOWED_SENDER_ORIGINS: string[] = [];

function validateSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  // In production, the renderer loads from file:// or app:// protocol.
  // In dev, it loads from the Vite dev server (localhost).
  if (url.startsWith('file://') || url.startsWith('app://') || url.startsWith('http://localhost')) {
    return;
  }

  throw new Error(`IPC rejected: sender origin not allowed (${url})`);
}

function toSafeFileStem(value: string): string {
  const invalidFileNameCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);

      return !invalidFileNameCharacters.has(character) && (code < 0 || code > 31);
    })
    .join('')
    .trim();

  return sanitized || 'conversation';
}

export function registerIpcHandlers(context: DesktopAppContext): void {
  ipcMain.handle(IpcChannels.windowMinimize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.minimize();
  });

  ipcMain.handle(IpcChannels.windowMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isMaximized()) {
      window?.unmaximize();
    } else {
      window?.maximize();
    }
  });

  ipcMain.handle(IpcChannels.windowClose, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.close();
  });

  ipcMain.handle(IpcChannels.windowIsMaximized, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isMaximized() ?? false;
  });

  const lastGenerationStatuses = new Map<string, GenerationJob['status']>();

  function focusAppFromNotification(jobId: string): void {
    const targetWindow = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed()
    );

    if (!targetWindow) {
      context.logger.info({ jobId }, 'Notification clicked but no app window is available');
      return;
    }

    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }

    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }

    targetWindow.focus();
    context.logger.info({ jobId }, 'Focused app window from desktop notification click');
  }

  function maybeShowGenerationNotification(job: GenerationJob): void {
    const previousStatus = lastGenerationStatuses.get(job.id);
    lastGenerationStatuses.set(job.id, job.status);

    if (previousStatus === job.status) {
      return;
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      return;
    }

    if (!Notification.isSupported()) {
      return;
    }

    if (!context.settingsService.get().notificationsEnabled) {
      return;
    }

    const promptPreview =
      job.prompt.length > 72 ? `${job.prompt.slice(0, 69).trimEnd()}...` : job.prompt;
    const body =
      job.status === 'completed'
        ? `${promptPreview}\nSaved to your local generation library.`
        : `${promptPreview}\n${job.errorMessage ?? `${job.kind === 'video' ? 'Video' : 'Image'} generation failed.`}`;

    try {
      const notification = new Notification({
        title:
          job.status === 'completed'
            ? `${job.kind === 'video' ? 'Video' : 'Image'} generation complete`
            : `${job.kind === 'video' ? 'Video' : 'Image'} generation failed`,
        body
      });

      notification.on('click', () => {
        app.focus({ steal: true });
        focusAppFromNotification(job.id);
      });

      notification.show();
    } catch (error) {
      context.logger.warn(
        {
          jobId: job.id,
          error: error instanceof Error ? error.message : 'Unknown notification error'
        },
        'Unable to show a desktop notification for a generation job'
      );
    }
  }

  context.generationService.subscribe((streamEvent) => {
    const event = generationStreamEventSchema.parse(streamEvent);

    if (event.type === 'job-updated') {
      maybeShowGenerationNotification(event.job);
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IpcChannels.generationStreamEvent, event);
      }
    }
  });

  ipcMain.handle(IpcChannels.settingsGet, () =>
    userSettingsSchema.parse(context.settingsService.get())
  );

  ipcMain.handle(IpcChannels.settingsUpdate, async (event, payload) => {
    validateSender(event);
    const previousSettings = context.settingsService.get();
    const nextSettings = context.settingsService.update(
      updateUserSettingsSchema.parse(payload)
    );

    if (previousSettings.pythonPort !== nextSettings.pythonPort) {
      await context.pythonManager.restart(nextSettings.pythonPort);
    }

    return userSettingsSchema.parse(nextSettings);
  });

  ipcMain.handle(IpcChannels.settingsPickAdditionalModelsDirectory, async () =>
    workspaceDirectorySelectionSchema.parse(
      await dialog.showOpenDialog({
        title: 'Select additional image models directory',
        properties: ['openDirectory']
      }).then((result) => ({
        path:
          result.canceled || result.filePaths.length === 0
            ? null
            : result.filePaths[0] ?? null
      }))
    )
  );

  ipcMain.handle(IpcChannels.systemGetStatus, async () =>
    systemStatusSchema.parse(await context.getSystemStatus())
  );

  ipcMain.handle(IpcChannels.generationStartImage, async (event, payload) => {
    validateSender(event);
    return imageGenerationStartResultSchema.parse(
      await context.generationService.startImageJob(
        imageGenerationRequestSchema.parse(payload)
      )
    )
  });

  ipcMain.handle(IpcChannels.generationStartVideo, async (event, payload) => {
    validateSender(event);
    return videoGenerationStartResultSchema.parse(
      await context.generationService.startVideoJob(
        videoGenerationRequestSchema.parse(payload)
      )
    )
  });

  ipcMain.handle(IpcChannels.generationListImageModels, (_event, payload) =>
    imageGenerationModelCatalogSchema.parse(
      context.generationService.listImageModels(
        payload
          ? listImageGenerationModelsInputSchema.parse(payload).additionalModelsDirectory
          : undefined
      )
    )
  );

  ipcMain.handle(IpcChannels.generationListJobs, (_event, payload) =>
    context.generationService
      .listJobs(payload ? listGenerationJobsInputSchema.parse(payload) : undefined)
      .map((job) => generationJobSchema.parse(job))
  );

  ipcMain.handle(IpcChannels.generationListGallery, async () =>
    (await context.generationService.listGalleryItems()).map((item) =>
      generationGalleryItemSchema.parse(item)
    )
  );

  ipcMain.handle(IpcChannels.generationCancelJob, async (_event, payload) =>
    generationJobSchema.parse(
      await context.generationService.cancelJob(
        cancelGenerationJobInputSchema.parse(payload)
      )
    )
  );

  ipcMain.handle(IpcChannels.generationRetryJob, async (_event, payload) =>
    imageGenerationStartResultSchema.parse(
      await context.generationService.retryJob(
        retryGenerationJobInputSchema.parse(payload)
      )
    )
  );

  ipcMain.handle(IpcChannels.generationDeleteArtifact, async (_event, payload) => {
    await context.generationService.deleteArtifact(
      deleteGenerationArtifactInputSchema.parse(payload)
    );
  });

  ipcMain.handle(IpcChannels.chatStart, async (event, payload) => {
    validateSender(event);
    const request = chatTurnRequestSchema.parse(payload);
    const accepted = await context.chatService.submitPrompt(
      request,
      (streamEvent: ChatStreamEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatStreamEvent, streamEvent);
        }
      }
    );

    return chatStartAcceptedSchema.parse(accepted);
  });

  ipcMain.handle(IpcChannels.chatConfirmGeneration, async (event, payload) => {
    validateSender(event);
    const accepted = await context.chatService.confirmGenerationIntent(
      confirmGenerationIntentInputSchema.parse(payload),
      (streamEvent: ChatStreamEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatStreamEvent, streamEvent);
        }
      }
    );

    return chatStartAcceptedSchema.parse(accepted);
  });

  ipcMain.handle(IpcChannels.chatPickAttachments, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select attachments',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported files',
          extensions: [
            'txt',
            'md',
            'mdx',
            'json',
            'yaml',
            'yml',
            'ts',
            'tsx',
            'js',
            'jsx',
            'py',
            'sql',
            'csv',
            'html',
            'css',
            'xml',
            'toml',
            'svg',
            'pdf',
            'png',
            'jpg',
            'jpeg',
            'webp'
          ]
        },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return (await context.chatService.prepareAttachments(result.filePaths)).map((attachment) =>
      messageAttachmentSchema.parse(attachment)
    );
  });

  ipcMain.handle(IpcChannels.chatEditAndResend, async (event, payload) => {
    validateSender(event);
    const accepted = await context.chatService.editMessageAndResend(
      editMessageInputSchema.parse(payload),
      (streamEvent: ChatStreamEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatStreamEvent, streamEvent);
        }
      }
    );

    return chatTurnAcceptedSchema.parse(accepted);
  });

  ipcMain.handle(IpcChannels.chatRegenerateResponse, async (event, payload) => {
    validateSender(event);
    const accepted = await context.chatService.regenerateResponse(
      regenerateResponseInputSchema.parse(payload),
      (streamEvent: ChatStreamEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatStreamEvent, streamEvent);
        }
      }
    );

    return chatTurnAcceptedSchema.parse(accepted);
  });

  ipcMain.handle(IpcChannels.chatCancelTurn, (_event, payload) => {
    context.chatService.cancelChatTurn(cancelChatTurnInputSchema.parse(payload));
  });

  ipcMain.handle(IpcChannels.chatDeleteConversation, (event, payload) => {
    validateSender(event);
    context.chatService.deleteConversation(
      deleteConversationInputSchema.parse(payload).conversationId
    );
  });

  ipcMain.handle(IpcChannels.chatPinMessage, (_event, payload) => {
    const request = pinMessageInputSchema.parse(payload);

    return storedMessageSchema.parse(
      context.chatService.pinMessage(request.messageId, request.pinned)
    );
  });

  ipcMain.handle(IpcChannels.chatGetAttachmentPreview, async (_event, payload) =>
    attachmentPreviewResultSchema.parse(
      await context.chatService.getAttachmentPreview(
        attachmentPreviewInputSchema.parse(payload).filePath
      )
    )
  );

  ipcMain.handle(IpcChannels.chatOpenLocalPath, async (_event, payload) => {
    const filePath = openLocalPathInputSchema.parse(payload).filePath;
    const normalizedPath = await context.chatService.openLocalPath(filePath);
    const openError = await shell.openPath(normalizedPath);

    if (typeof openError === 'string' && openError.trim().length > 0) {
      throw new Error(openError.trim());
    }
  });

  ipcMain.handle(IpcChannels.chatListWorkspaces, () =>
    context.chatService
      .listWorkspaces()
      .map((workspace) => workspaceSummarySchema.parse(workspace))
  );

  ipcMain.handle(IpcChannels.chatCreateWorkspace, async (_event, payload) =>
    workspaceSummarySchema.parse(
      await context.chatService.createWorkspace(createWorkspaceInputSchema.parse(payload))
    )
  );

  ipcMain.handle(IpcChannels.chatPickWorkspaceDirectory, async () => {
    const openResult = await dialog.showOpenDialog({
      title: 'Connect workspace folder',
      properties: ['openDirectory']
    });

    return workspaceDirectorySelectionSchema.parse({
      path:
        openResult.canceled || openResult.filePaths.length === 0
          ? null
          : openResult.filePaths[0] ?? null
    });
  });

  ipcMain.handle(IpcChannels.chatUpdateWorkspaceRoot, async (_event, payload) =>
    workspaceSummarySchema.parse(
      await context.chatService.updateWorkspaceRoot(
        updateWorkspaceRootInputSchema.parse(payload)
      )
    )
  );

  ipcMain.handle(IpcChannels.chatDeleteWorkspace, (event, payload) => {
    validateSender(event);
    context.chatService.deleteWorkspace(deleteWorkspaceInputSchema.parse(payload).workspaceId);
  });

  ipcMain.handle(IpcChannels.chatListConversations, () =>
    context.chatService
      .listConversations()
      .map((conversation) => conversationSummarySchema.parse(conversation))
  );

  ipcMain.handle(IpcChannels.chatSearchConversations, (_event, payload) =>
    context.chatService
      .searchConversations(searchConversationsInputSchema.parse(payload).query)
      .map((result) => conversationSearchResultSchema.parse(result))
  );

  ipcMain.handle(IpcChannels.chatGetMessages, (_event, conversationId) =>
    context.chatService
      .listMessagesForUi(conversationIdSchema.parse(conversationId))
      .map((message) => storedMessageSchema.parse(message))
  );

  ipcMain.handle(IpcChannels.chatGetMessage, (_event, messageId) => {
    const message = context.chatService.getMessage(messageIdSchema.parse(messageId));
    return message ? storedMessageSchema.parse(message) : null;
  });

  ipcMain.handle(IpcChannels.chatListTools, () =>
    context.chatService.listTools().map((tool) => toolDefinitionSchema.parse(tool))
  );

  ipcMain.handle(IpcChannels.chatListSkills, () =>
    context.chatService.listSkills().map((skill) => skillDefinitionSchema.parse(skill))
  );

  ipcMain.handle(IpcChannels.chatCreateSkill, (_event, payload) =>
    skillDefinitionSchema.parse(
      context.chatService.createSkill(createSkillInputSchema.parse(payload))
    )
  );

  ipcMain.handle(IpcChannels.chatUpdateSkill, (_event, payload) =>
    skillDefinitionSchema.parse(
      context.chatService.updateSkill(updateSkillInputSchema.parse(payload))
    )
  );

  ipcMain.handle(IpcChannels.chatDeleteSkill, (event, payload) => {
    validateSender(event);
    context.chatService.deleteSkill(deleteSkillInputSchema.parse(payload));
  });

  ipcMain.handle(IpcChannels.personaList, () =>
    context.personaService.list().map((persona) => personaDefinitionSchema.parse(persona))
  );
  ipcMain.handle(IpcChannels.personaCreate, (event, payload) => {
    validateSender(event);
    return personaDefinitionSchema.parse(
      context.personaService.create(createPersonaInputSchema.parse(payload))
    );
  });
  ipcMain.handle(IpcChannels.personaUpdate, (event, payload) => {
    validateSender(event);
    return personaDefinitionSchema.parse(
      context.personaService.update(updatePersonaInputSchema.parse(payload))
    );
  });
  ipcMain.handle(IpcChannels.personaDelete, (event, payload) => {
    validateSender(event);
    context.personaService.delete(deletePersonaInputSchema.parse(payload).personaId);
  });
  ipcMain.handle(IpcChannels.personaGetActive, () => {
    const active = context.personaService.getActivePersona();
    return active ? personaDefinitionSchema.parse(active) : null;
  });
  ipcMain.handle(IpcChannels.personaSetActive, (event, payload) => {
    validateSender(event);
    const input = setActivePersonaInputSchema.parse(payload);
    context.personaService.setActivePersona(input.personaId);
  });

  ipcMain.handle(IpcChannels.chatListKnowledgeDocuments, (_event, payload) =>
    context.chatService
      .listKnowledgeDocuments(knowledgeDocumentsInputSchema.parse(payload).workspaceId)
      .map((document) => knowledgeDocumentSchema.parse(document))
  );

  ipcMain.handle(IpcChannels.chatImportWorkspaceKnowledge, async (_event, payload) => {
    const request = knowledgeDocumentsInputSchema.parse(payload);
    const openResult = await dialog.showOpenDialog({
      title: 'Import workspace knowledge',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported files',
          extensions: [
            'txt',
            'md',
            'mdx',
            'json',
            'yaml',
            'yml',
            'ts',
            'tsx',
            'js',
            'jsx',
            'py',
            'sql',
            'csv',
            'html',
            'css',
            'xml',
            'toml',
            'svg',
            'pdf'
          ]
        },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (openResult.canceled || openResult.filePaths.length === 0) {
      throw new Error('Knowledge import was cancelled.');
    }

    const attachments = await context.chatService.prepareAttachments(openResult.filePaths);

    return importWorkspaceKnowledgeResultSchema.parse(
      context.chatService.importWorkspaceKnowledge(request.workspaceId, attachments)
    );
  });

  ipcMain.handle(IpcChannels.chatImportConversation, async () => {
    const openResult = await dialog.showOpenDialog({
      title: 'Import conversation',
      properties: ['openFile'],
      filters: [
        { name: 'Conversation exports', extensions: ['json', 'md'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Markdown', extensions: ['md'] }
      ]
    });

    if (openResult.canceled || openResult.filePaths.length === 0) {
      throw new Error('Conversation import was cancelled.');
    }

    const selectedPath = openResult.filePaths[0];

    if (!selectedPath) {
      throw new Error('Conversation import was cancelled.');
    }

    return importConversationResultSchema.parse(
      await context.chatService.importConversationFromFile(selectedPath)
    );
  });

  ipcMain.handle(IpcChannels.chatExportConversation, async (event, payload) => {
    const request = exportConversationInputSchema.parse(payload);
    const conversation = context.chatService
      .listConversations()
      .find((item) => item.id === request.conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} was not found.`);
    }

    const saveResult = await dialog.showSaveDialog({
      title: 'Export conversation',
      defaultPath: `${toSafeFileStem(conversation.title)}.${
        request.format === 'json' ? 'json' : 'md'
      }`,
      filters: [
        request.format === 'json'
          ? { name: 'JSON', extensions: ['json'] }
          : { name: 'Markdown', extensions: ['md'] }
      ]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      throw new Error('Conversation export was cancelled.');
    }

    const contents = context.chatService.exportConversation(request);
    writeFileSync(saveResult.filePath, contents, 'utf8');

    return exportConversationResultSchema.parse({
      path: saveResult.filePath
    });
  });

  ipcMain.handle(IpcChannels.chatGetComposerDraft, (_event, payload) => {
    return context.appStateRepository.getDraft(conversationIdSchema.parse(payload));
  });

  ipcMain.handle(IpcChannels.chatSetComposerDraft, (event, payload) => {
    validateSender(event);
    const input = composerDraftInputSchema.parse(payload);
    if (input.prompt.length === 0) {
      context.appStateRepository.clearDraft(input.conversationId);
    } else {
      context.appStateRepository.setDraft(input.conversationId, input.prompt);
    }
  });

  ipcMain.handle(IpcChannels.chatClearComposerDraft, (_event, payload) => {
    context.appStateRepository.clearDraft(conversationIdSchema.parse(payload));
  });

  ipcMain.handle(IpcChannels.appStateGetLastSession, () => {
    return context.appStateRepository.getLastSession();
  });

  ipcMain.handle(IpcChannels.appStateSetLastSession, (event, payload) => {
    validateSender(event);
    const input = lastSessionSchema.parse(payload);
    context.appStateRepository.setLastSession(input.conversationId, input.workspaceId);
  });

  ipcMain.handle(IpcChannels.capabilitiesListPermissions, () =>
    context.capabilityService
      .listPermissions()
      .map((permission) => capabilityPermissionSchema.parse(permission))
  );

  ipcMain.handle(IpcChannels.capabilitiesGrantPermission, (event, payload) => {
    validateSender(event);
    return capabilityPermissionSchema.parse(
      context.capabilityService.grantPermission(
        capabilityPermissionInputSchema.parse(payload)
      )
    );
  });

  ipcMain.handle(IpcChannels.capabilitiesRevokePermission, (event, payload) => {
    validateSender(event);
    context.capabilityService.revokePermission(
      capabilityPermissionInputSchema.parse(payload)
    );
  });

  ipcMain.handle(IpcChannels.capabilitiesListTasks, (_event, workspaceId: string | null) =>
    context.capabilityService
      .listTasks(workspaceId)
      .map((task) => capabilityTaskSchema.parse(task))
  );

  ipcMain.handle(IpcChannels.capabilitiesGetTask, (_event, taskId) => {
    const task = context.capabilityService.getTask(conversationIdSchema.parse(taskId));
    return task ? capabilityTaskSchema.parse(task) : null;
  });

  ipcMain.handle(IpcChannels.capabilitiesDeleteTask, (_event, taskId) => {
    context.capabilityService.deleteTask(conversationIdSchema.parse(taskId));
  });

  ipcMain.handle(IpcChannels.capabilitiesListSchedules, () =>
    context.capabilityService
      .listSchedules()
      .map((schedule) => scheduledPromptSchema.parse(schedule))
  );

  ipcMain.handle(IpcChannels.capabilitiesListAgents, () =>
    context.capabilityService
      .listAgents()
      .map((agent) => agentSessionSchema.parse(agent))
  );

  ipcMain.handle(IpcChannels.capabilitiesListTeams, () =>
    context.capabilityService
      .listTeams()
      .map((team) => teamSessionSchema.parse(team))
  );

  ipcMain.handle(IpcChannels.capabilitiesListWorktrees, () =>
    context.capabilityService
      .listWorktrees()
      .map((worktree) => worktreeSessionSchema.parse(worktree))
  );

  ipcMain.handle(IpcChannels.capabilitiesGetPlanState, (_event, workspaceId: string | null) =>
    planStateSchema.parse(context.capabilityService.getPlanState(workspaceId))
  );

  ipcMain.handle(IpcChannels.capabilitiesListAuditEvents, () =>
    context.capabilityService
      .listAuditEvents()
      .map((event) => auditEventRecordSchema.parse(event))
  );
}
