import { contextBridge, ipcRenderer } from 'electron';
import {
  agentSessionSchema,
  auditEventRecordSchema,
  type ChatStreamEvent,
  type DesktopApi,
  IpcChannels,
  attachmentPreviewInputSchema,
  attachmentPreviewResultSchema,
  cancelGenerationJobInputSchema,
  cancelChatTurnInputSchema,
  capabilityPermissionInputSchema,
  capabilityPermissionSchema,
  capabilityTaskSchema,
  chatStartAcceptedSchema,
  chatTurnRequestSchema,
  chatStreamEventSchema,
  chatTurnAcceptedSchema,
  conversationIdSchema,
  deleteConversationInputSchema,
  editMessageInputSchema,
  generationJobSchema,
  generationStreamEventSchema,
  imageGenerationRequestSchema,
  importConversationResultSchema,
  conversationSearchResultSchema,
  conversationSummarySchema,
  createWorkspaceInputSchema,
  deleteWorkspaceInputSchema,
  exportConversationInputSchema,
  exportConversationResultSchema,
  imageGenerationModelCatalogSchema,
  importWorkspaceKnowledgeResultSchema,
  messageAttachmentSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentsInputSchema,
  listImageGenerationModelsInputSchema,
  listGenerationJobsInputSchema,
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
  updateWorkspaceRootInputSchema,
  updateUserSettingsSchema,
  userSettingsSchema,
  worktreeSessionSchema,
  workspaceDirectorySelectionSchema,
  workspaceSummarySchema
} from '@bridge/ipc/contracts';

const desktopApi: DesktopApi = {
  settings: {
    get: async () => userSettingsSchema.parse(await ipcRenderer.invoke(IpcChannels.settingsGet)),
    update: async (input) =>
      userSettingsSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.settingsUpdate,
          updateUserSettingsSchema.parse(input)
        )
      ),
    pickAdditionalModelsDirectory: async () =>
      workspaceDirectorySelectionSchema.parse(
        await ipcRenderer.invoke(IpcChannels.settingsPickAdditionalModelsDirectory)
      )
  },
  system: {
    getStatus: async () =>
      systemStatusSchema.parse(await ipcRenderer.invoke(IpcChannels.systemGetStatus))
  },
  generation: {
    startImage: async (input) =>
      generationJobSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.generationStartImage,
          imageGenerationRequestSchema.parse(input)
        )
      ),
    listImageModels: async (input) =>
      imageGenerationModelCatalogSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.generationListImageModels,
          input ? listImageGenerationModelsInputSchema.parse(input) : undefined
        )
      ),
    listJobs: async (input) => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.generationListJobs,
        input ? listGenerationJobsInputSchema.parse(input) : undefined
      )) as unknown[];

      return payload.map((job) => generationJobSchema.parse(job));
    },
    cancelJob: async (input) =>
      generationJobSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.generationCancelJob,
          cancelGenerationJobInputSchema.parse(input)
        )
      ),
    retryJob: async (input) =>
      generationJobSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.generationRetryJob,
          retryGenerationJobInputSchema.parse(input)
        )
      ),
    onJobEvent: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: unknown
      ) => {
        listener(generationStreamEventSchema.parse(payload));
      };

      ipcRenderer.on(IpcChannels.generationStreamEvent, handler);

      return () => {
        ipcRenderer.removeListener(IpcChannels.generationStreamEvent, handler);
      };
    }
  },
  chat: {
    start: async (input) =>
      chatStartAcceptedSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatStart,
          chatTurnRequestSchema.parse(input)
        )
      ),
    pickAttachments: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatPickAttachments
      )) as unknown[];

      return payload.map((attachment) => messageAttachmentSchema.parse(attachment));
    },
    editAndResend: async (input) =>
      chatTurnAcceptedSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatEditAndResend,
          editMessageInputSchema.parse(input)
        )
      ),
    regenerateResponse: async (input) =>
      chatTurnAcceptedSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatRegenerateResponse,
          regenerateResponseInputSchema.parse(input)
        )
      ),
    cancelTurn: async (input) => {
      await ipcRenderer.invoke(
        IpcChannels.chatCancelTurn,
        cancelChatTurnInputSchema.parse(input)
      );
    },
    deleteConversation: async (input) => {
      await ipcRenderer.invoke(
        IpcChannels.chatDeleteConversation,
        deleteConversationInputSchema.parse(input)
      );
    },
    pinMessage: async (input) =>
      storedMessageSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatPinMessage,
          pinMessageInputSchema.parse(input)
        )
      ),
    getAttachmentPreview: async (input) =>
      attachmentPreviewResultSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatGetAttachmentPreview,
          attachmentPreviewInputSchema.parse(input)
        )
      ),
    openLocalPath: async (input) => {
      await ipcRenderer.invoke(
        IpcChannels.chatOpenLocalPath,
        openLocalPathInputSchema.parse(input)
      );
    },
    listWorkspaces: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatListWorkspaces
      )) as unknown[];

      return payload.map((workspace) => workspaceSummarySchema.parse(workspace));
    },
    createWorkspace: async (input) =>
      workspaceSummarySchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatCreateWorkspace,
          createWorkspaceInputSchema.parse(input)
        )
      ),
    pickWorkspaceDirectory: async () =>
      workspaceDirectorySelectionSchema.parse(
        await ipcRenderer.invoke(IpcChannels.chatPickWorkspaceDirectory)
      ),
    updateWorkspaceRoot: async (input) =>
      workspaceSummarySchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatUpdateWorkspaceRoot,
          updateWorkspaceRootInputSchema.parse(input)
        )
      ),
    deleteWorkspace: async (input) => {
      await ipcRenderer.invoke(
        IpcChannels.chatDeleteWorkspace,
        deleteWorkspaceInputSchema.parse(input)
      );
    },
    listConversations: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatListConversations
      )) as unknown[];

      return payload.map((conversation) =>
        conversationSummarySchema.parse(conversation)
      );
    },
    searchConversations: async (input) => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatSearchConversations,
        searchConversationsInputSchema.parse(input)
      )) as unknown[];

      return payload.map((result) => conversationSearchResultSchema.parse(result));
    },
    getConversationMessages: async (conversationId) => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatGetMessages,
        conversationIdSchema.parse(conversationId)
      )) as unknown[];

      return payload.map((message) => storedMessageSchema.parse(message));
    },
    listTools: async () => {
      const payload = (await ipcRenderer.invoke(IpcChannels.chatListTools)) as unknown[];

      return payload.map((tool) => toolDefinitionSchema.parse(tool));
    },
    listSkills: async () => {
      const payload = (await ipcRenderer.invoke(IpcChannels.chatListSkills)) as unknown[];

      return payload.map((skill) => skillDefinitionSchema.parse(skill));
    },
    listKnowledgeDocuments: async (input) => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.chatListKnowledgeDocuments,
        knowledgeDocumentsInputSchema.parse(input)
      )) as unknown[];

      return payload.map((document) => knowledgeDocumentSchema.parse(document));
    },
    importWorkspaceKnowledge: async (input) =>
      importWorkspaceKnowledgeResultSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatImportWorkspaceKnowledge,
          knowledgeDocumentsInputSchema.parse(input)
        )
      ),
    importConversation: async () =>
      importConversationResultSchema.parse(
        await ipcRenderer.invoke(IpcChannels.chatImportConversation)
      ),
    exportConversation: async (input) =>
      exportConversationResultSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.chatExportConversation,
          exportConversationInputSchema.parse(input)
        )
      ),
    onStreamEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent) => {
        listener(chatStreamEventSchema.parse(payload));
      };

      ipcRenderer.on(IpcChannels.chatStreamEvent, handler);

      return () => {
        ipcRenderer.removeListener(IpcChannels.chatStreamEvent, handler);
      };
    }
  },
  capabilities: {
    listPermissions: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListPermissions
      )) as unknown[];

      return payload.map((permission) => capabilityPermissionSchema.parse(permission));
    },
    grantPermission: async (input) =>
      capabilityPermissionSchema.parse(
        await ipcRenderer.invoke(
          IpcChannels.capabilitiesGrantPermission,
          capabilityPermissionInputSchema.parse(input)
        )
      ),
    revokePermission: async (input) => {
      await ipcRenderer.invoke(
        IpcChannels.capabilitiesRevokePermission,
        capabilityPermissionInputSchema.parse(input)
      );
    },
    listTasks: async (workspaceId: string | null) => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListTasks,
        workspaceId
      )) as unknown[];

      return payload.map((task) => capabilityTaskSchema.parse(task));
    },
    getTask: async (taskId) => {
      const payload: unknown = await ipcRenderer.invoke(
        IpcChannels.capabilitiesGetTask,
        conversationIdSchema.parse(taskId)
      );

      return payload ? capabilityTaskSchema.parse(payload) : null;
    },
    deleteTask: async (taskId) => {
      await ipcRenderer.invoke(
        IpcChannels.capabilitiesDeleteTask,
        conversationIdSchema.parse(taskId)
      );
    },
    listSchedules: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListSchedules
      )) as unknown[];

      return payload.map((schedule) => scheduledPromptSchema.parse(schedule));
    },
    listAgents: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListAgents
      )) as unknown[];

      return payload.map((agent) => agentSessionSchema.parse(agent));
    },
    listTeams: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListTeams
      )) as unknown[];

      return payload.map((team) => teamSessionSchema.parse(team));
    },
    listWorktrees: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListWorktrees
      )) as unknown[];

      return payload.map((worktree) => worktreeSessionSchema.parse(worktree));
    },
    getPlanState: async (workspaceId: string | null) =>
      planStateSchema.parse(
        await ipcRenderer.invoke(IpcChannels.capabilitiesGetPlanState, workspaceId)
      ),
    listAuditEvents: async () => {
      const payload = (await ipcRenderer.invoke(
        IpcChannels.capabilitiesListAuditEvents
      )) as unknown[];

      return payload.map((event) => auditEventRecordSchema.parse(event));
    }
  }
};

contextBridge.exposeInMainWorld('ollamaDesktop', desktopApi);
