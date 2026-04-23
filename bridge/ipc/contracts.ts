import { z } from 'zod';

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().min(1);
const skillIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/u, 'Use lowercase letters, numbers, hyphens, or underscores.');

export const messageRoleSchema = z.enum(['system', 'user', 'assistant']);
export const messageStatusSchema = z.enum(['pending', 'streaming', 'completed', 'failed']);
export const generationJobKindSchema = z.enum(['image', 'video']);
export const generationJobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
]);
export const textInferenceBackendSchema = z.enum(['ollama', 'nvidia']);
export const generationModeSchema = z.enum([
  'text-to-image',
  'image-to-image',
  'image-to-video'
]);
export const generationWorkflowProfileSchema = z.enum([
  'default',
  'qwen-image-edit-2511',
  'wan-image-to-video'
]);
export const routeStrategySchema = z.enum([
  'chat',
  'skill-chat',
  'tool',
  'tool-chat',
  'rag-chat',
  'rag-tool'
]);
export const toolInvocationStatusSchema = z.enum(['completed', 'failed']);
export const contextSourceKindSchema = z.enum(['document_chunk', 'pinned_message']);
export const generationArtifactKindSchema = z.enum(['image', 'video']);
export const capabilityKindSchema = z.enum([
  'tool',
  'mode',
  'agent',
  'task',
  'team',
  'schedule',
  'workspace',
  'mcp',
  'skill',
  'lsp'
]);
export const capabilityPermissionClassSchema = z.enum([
  'none',
  'confirm_once',
  'always_confirm'
]);
export const capabilityAvailabilitySchema = z.enum([
  'available',
  'blocked',
  'unavailable'
]);
export const permissionScopeKindSchema = z.enum(['global', 'workspace', 'session']);
export const capabilityTaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'failed'
]);
export const scheduleKindSchema = z.enum(['once', 'interval']);
export const agentSessionStatusSchema = z.enum([
  'idle',
  'running',
  'completed',
  'stopped',
  'failed'
]);
export const teamStatusSchema = z.enum(['active', 'archived']);
export const worktreeStatusSchema = z.enum(['active', 'closed']);
export const planModeStatusSchema = z.enum(['inactive', 'active']);

export const imageGenerationModelBackendSchema = z.enum([
  'placeholder',
  'diffusers',
  'comfyui'
]);
export const imageGenerationModelSourceSchema = z.enum([
  'builtin',
  'local-directory',
  'local-checkpoint',
  'local-gguf',
  'configured'
]);
export const imageGenerationModelLoadStrategySchema = z.enum([
  'placeholder',
  'diffusers-directory',
  'diffusers-single-file',
  'diffusers-gguf',
  'comfyui-workflow',
  'remote-repo'
]);
export const imageGenerationModelFamilySchema = z.enum([
  'placeholder',
  'diffusers',
  'qwen-image',
  'qwen-image-edit',
  'wan-video',
  'unknown'
]);

export const imageGenerationModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  backend: imageGenerationModelBackendSchema,
  source: imageGenerationModelSourceSchema,
  loadStrategy: imageGenerationModelLoadStrategySchema,
  family: imageGenerationModelFamilySchema,
  supported: z.boolean(),
  supportReason: z.string().nullable(),
  baseModelId: z.string().min(1).nullable(),
  path: z.string().min(1).nullable()
});

export const builtinImageGenerationModelOption = imageGenerationModelOptionSchema.parse({
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
});

export const messageAttachmentSchema = z.object({
  id: uuidSchema,
  fileName: z.string().min(1),
  filePath: z.string().min(1).nullable(),
  mimeType: z.string().min(1).nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  extractedText: z.string().nullable(),
  createdAt: timestampSchema
});

export const toolDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  command: z.string().min(1),
  kind: capabilityKindSchema.default('tool'),
  permissionClass: capabilityPermissionClassSchema.default('none'),
  availability: capabilityAvailabilitySchema.default('available'),
  autoRoutable: z.boolean().default(true)
});

export const skillDefinitionSchema = z.object({
  id: skillIdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  source: z.enum(['builtin', 'user']),
  readOnly: z.boolean().optional(),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional()
});

export const toolInvocationSchema = z.object({
  id: uuidSchema,
  toolId: z.string().min(1),
  displayName: z.string().min(1),
  status: toolInvocationStatusSchema,
  inputSummary: z.string().min(1),
  outputSummary: z.string().nullable(),
  outputText: z.string().nullable().optional(),
  errorMessage: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const contextSourceSchema = z.object({
  id: uuidSchema,
  kind: contextSourceKindSchema,
  label: z.string().min(1),
  excerpt: z.string(),
  sourcePath: z.string().min(1).nullable(),
  documentId: uuidSchema.nullable(),
  score: z.number().nullable()
});

export const messageUsageSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0)
});

export const routeTraceSchema = z.object({
  strategy: routeStrategySchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  selectedModel: z.string().min(1).nullable(),
  fallbackModel: z.string().min(1).nullable(),
  activeSkillId: z.string().min(1).nullable(),
  activeToolId: z.string().min(1).nullable(),
  usedWorkspacePrompt: z.boolean(),
  usedPinnedMessages: z.boolean(),
  usedRag: z.boolean(),
  usedTools: z.boolean()
});

export const knowledgeDocumentSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  title: z.string().min(1),
  sourcePath: z.string().min(1).nullable(),
  mimeType: z.string().min(1).nullable(),
  tokenEstimate: z.number().int().min(0).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const generationArtifactSchema = z.object({
  id: uuidSchema,
  jobId: uuidSchema,
  kind: generationArtifactKindSchema,
  filePath: z.string().min(1),
  previewPath: z.string().min(1).nullable(),
  mimeType: z.string().min(1),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: timestampSchema
});

export const generationJobSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema.nullable(),
  conversationId: uuidSchema.nullable(),
  kind: generationJobKindSchema,
  mode: generationModeSchema,
  workflowProfile: generationWorkflowProfileSchema,
  status: generationJobStatusSchema,
  prompt: z.string().min(1),
  negativePrompt: z.string().nullable(),
  model: z.string().min(1),
  backend: z.enum(['placeholder', 'diffusers', 'comfyui']),
  width: z.number().int().min(256).max(2048),
  height: z.number().int().min(256).max(2048),
  steps: z.number().int().min(1).max(100),
  guidanceScale: z.number().min(0).max(50),
  seed: z.number().int().nullable(),
  frameCount: z.number().int().min(1).max(241).nullable().default(null),
  frameRate: z.number().min(1).max(120).nullable().default(null),
  progress: z.number().min(0).max(1),
  stage: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  referenceImages: z.array(messageAttachmentSchema),
  artifacts: z.array(generationArtifactSchema)
});

export const storedMessageSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  role: messageRoleSchema,
  content: z.string(),
  attachments: z.array(messageAttachmentSchema),
  status: messageStatusSchema,
  model: z.string().nullable(),
  correlationId: uuidSchema.nullable(),
  pinned: z.boolean().optional(),
  toolInvocationCount: z.number().int().min(0).optional(),
  toolInvocations: z.array(toolInvocationSchema).optional(),
  contextSourceCount: z.number().int().min(0).optional(),
  contextSources: z.array(contextSourceSchema).optional(),
  usage: messageUsageSchema.nullable().optional(),
  routeTrace: routeTraceSchema.nullable().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const conversationSummarySchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema.nullable(),
  title: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const workspaceSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  prompt: z.string().nullable(),
  rootPath: z.string().min(1).nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const conversationSearchResultSchema = z.object({
  conversation: conversationSummarySchema,
  workspaceName: z.string().nullable(),
  snippet: z.string().nullable()
});

export const capabilityPermissionSchema = z.object({
  id: uuidSchema,
  capabilityId: z.string().min(1),
  scopeKind: permissionScopeKindSchema,
  scopeId: z.string().min(1).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema.nullable()
});

export const capabilityTaskSchema = z.object({
  id: uuidSchema,
  sequence: z.number().int().nonnegative(),
  workspaceId: uuidSchema.nullable(),
  title: z.string().min(1),
  status: capabilityTaskStatusSchema,
  details: z.string().nullable(),
  outputPath: z.string().min(1).nullable(),
  parentTaskId: uuidSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable()
});

export const scheduledPromptSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1),
  prompt: z.string().min(1),
  kind: scheduleKindSchema,
  intervalSeconds: z.number().int().positive().nullable(),
  runAt: timestampSchema.nullable(),
  enabled: z.boolean(),
  lastRunAt: timestampSchema.nullable(),
  nextRunAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const agentMessageSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  createdAt: timestampSchema
});

export const agentSessionSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1),
  status: agentSessionStatusSchema,
  systemPrompt: z.string().nullable(),
  teamId: uuidSchema.nullable(),
  parentConversationId: uuidSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastMessageAt: timestampSchema.nullable(),
  messages: z.array(agentMessageSchema)
});

export const teamSessionSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1),
  status: teamStatusSchema,
  memberIds: z.array(uuidSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const worktreeSessionSchema = z.object({
  id: uuidSchema,
  repoRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  status: worktreeStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const planStateSchema = z.object({
  conversationId: uuidSchema.nullable(),
  workspaceId: uuidSchema.nullable(),
  status: planModeStatusSchema,
  summary: z.string().nullable(),
  createdAt: timestampSchema.nullable(),
  updatedAt: timestampSchema.nullable()
});

export const auditEventRecordSchema = z.object({
  id: uuidSchema,
  category: z.string().min(1),
  action: z.string().min(1),
  outcome: z.string().min(1),
  summary: z.string().min(1),
  createdAt: timestampSchema
});

export const userSettingsSchema = z.object({
  textInferenceBackend: textInferenceBackendSchema,
  ollamaBaseUrl: z.string().url(),
  nvidiaBaseUrl: z.string().url(),
  nvidiaApiKey: z.string(),
  defaultModel: z.string(),
  codingModel: z.string(),
  visionModel: z.string(),
  imageGenerationModel: z.string(),
  additionalModelsDirectory: z.string().min(1).nullable(),
  videoGenerationModel: z.string(),
  videoGenerationHighNoiseModel: z.string(),
  videoGenerationLowNoiseModel: z.string(),
  pythonPort: z.number().int().min(1024).max(65535),
  streamingMascotEnabled: z.boolean(),
  theme: z.enum(['system', 'light', 'dark'])
});

export const updateUserSettingsSchema = userSettingsSchema.partial();

export const ollamaModelSchema = z.object({
  name: z.string().min(1),
  size: z.number().nullable(),
  digest: z.string().nullable()
});

export const ollamaStatusSchema = z.object({
  reachable: z.boolean(),
  baseUrl: z.string().url(),
  checkedAt: timestampSchema,
  error: z.string().nullable(),
  models: z.array(ollamaModelSchema)
});

export const nvidiaStatusSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().url(),
  checkedAt: timestampSchema,
  error: z.string().nullable(),
  models: z.array(ollamaModelSchema)
});

export const pythonStatusSchema = z.object({
  reachable: z.boolean(),
  url: z.string().url(),
  checkedAt: timestampSchema,
  pid: z.number().int().nullable(),
  error: z.string().nullable(),
  runtime: z.string().nullable(),
  modelManager: z
    .object({
      loadedModel: z.string().nullable(),
      loadedBackend: z.enum(['placeholder', 'diffusers', 'comfyui']).nullable(),
      device: z.string().min(1),
      lastError: z.string().nullable()
    })
    .nullable(),
  vram: z
    .object({
      device: z.string().min(1),
      cudaAvailable: z.boolean(),
      totalMb: z.number().nullable(),
      freeMb: z.number().nullable(),
      reservedMb: z.number().nullable(),
      allocatedMb: z.number().nullable()
    })
    .nullable()
});

export const databaseStatusSchema = z.object({
  ready: z.boolean(),
  path: z.string().min(1)
});

export const systemStatusSchema = z.object({
  appVersion: z.string().min(1),
  database: databaseStatusSchema,
  activeTextBackend: textInferenceBackendSchema,
  ollama: ollamaStatusSchema,
  nvidia: nvidiaStatusSchema,
  python: pythonStatusSchema,
  pendingRequestCount: z.number().int().min(0)
});

export const ollamaThinkModeSchema = z.enum(['off', 'on', 'low', 'medium', 'high']);

export const chatTurnRequestSchema = z.object({
  conversationId: uuidSchema.optional(),
  workspaceId: uuidSchema.optional(),
  prompt: z.string().trim().min(1),
  attachments: z.array(messageAttachmentSchema).max(8).optional(),
  model: z.string().trim().min(1).optional(),
  think: ollamaThinkModeSchema.optional()
});

export const imageGenerationModeSchema = z.enum(['text-to-image', 'image-to-image']);
export const imageGenerationWorkflowProfileSchema = z.enum([
  'default',
  'qwen-image-edit-2511'
]);
export const videoGenerationModeSchema = z.enum(['image-to-video']);
export const videoGenerationWorkflowProfileSchema = z.enum(['wan-image-to-video']);

export const imageGenerationRequestSchema = z.object({
  conversationId: uuidSchema.optional(),
  workspaceId: uuidSchema.optional(),
  prompt: z.string().trim().min(1),
  negativePrompt: z.string().trim().max(2000).optional(),
  model: z.string().trim().min(1).optional(),
  mode: imageGenerationModeSchema.optional(),
  workflowProfile: imageGenerationWorkflowProfileSchema.optional(),
  referenceImages: z.array(messageAttachmentSchema).max(5).optional(),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  guidanceScale: z.number().min(0).max(50).optional(),
  seed: z.number().int().nullable().optional()
});

export const videoGenerationRequestSchema = z.object({
  conversationId: uuidSchema.optional(),
  workspaceId: uuidSchema.optional(),
  prompt: z.string().trim().min(1),
  negativePrompt: z.string().trim().max(4000).optional(),
  model: z.string().trim().min(1).optional(),
  highNoiseModel: z.string().trim().min(1).optional(),
  lowNoiseModel: z.string().trim().min(1).optional(),
  mode: videoGenerationModeSchema.optional(),
  workflowProfile: videoGenerationWorkflowProfileSchema.optional(),
  referenceImages: z.array(messageAttachmentSchema).min(1).max(1),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  guidanceScale: z.number().min(0).max(50).optional(),
  seed: z.number().int().nullable().optional(),
  frameCount: z.number().int().min(1).max(241).optional(),
  frameRate: z.number().min(1).max(120).optional()
});

export const listImageGenerationModelsInputSchema = z.object({
  additionalModelsDirectory: z.string().trim().min(1).nullable().optional()
});

export const imageGenerationModelCatalogSchema = z.object({
  additionalModelsDirectory: z.string().min(1).nullable(),
  options: z.array(imageGenerationModelOptionSchema),
  warnings: z.array(z.string())
});

export const listGenerationJobsInputSchema = z.object({
  workspaceId: uuidSchema.optional(),
  conversationId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).optional()
});

export const cancelGenerationJobInputSchema = z.object({
  jobId: uuidSchema
});

export const retryGenerationJobInputSchema = z.object({
  jobId: uuidSchema
});

export const searchConversationsInputSchema = z.object({
  query: z.string().trim().min(1)
});

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().max(5000).optional(),
  rootPath: z.string().trim().min(1)
});

export const updateWorkspaceRootInputSchema = z.object({
  workspaceId: uuidSchema,
  rootPath: z.string().trim().min(1).nullable()
});

export const deleteWorkspaceInputSchema = z.object({
  workspaceId: uuidSchema
});

export const createSkillInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(280),
  prompt: z.string().trim().min(1).max(50_000)
});

export const updateSkillInputSchema = createSkillInputSchema.extend({
  skillId: skillIdSchema
});

export const deleteSkillInputSchema = z.object({
  skillId: skillIdSchema
});

export const capabilityPermissionInputSchema = z.object({
  capabilityId: z.string().trim().min(1),
  scopeKind: permissionScopeKindSchema,
  scopeId: z.string().trim().min(1).nullable().optional(),
  expiresAt: timestampSchema.nullable().optional()
});

export const workspaceDirectorySelectionSchema = z.object({
  path: z.string().min(1).nullable()
});

export const createCapabilityTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  details: z.string().trim().max(10_000).optional(),
  workspaceId: uuidSchema.optional(),
  parentTaskId: uuidSchema.optional()
});

export const updateCapabilityTaskInputSchema = z.object({
  taskId: uuidSchema,
  title: z.string().trim().min(1).max(160).optional(),
  details: z.string().trim().max(10_000).nullable().optional(),
  status: capabilityTaskStatusSchema.optional(),
  outputPath: z.string().trim().min(1).nullable().optional()
});

export const stopCapabilityTaskInputSchema = z.object({
  taskId: uuidSchema
});

export const deleteCapabilityTaskInputSchema = z.object({
  taskId: uuidSchema
});

export const createScheduledPromptInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(10_000),
  kind: scheduleKindSchema,
  intervalSeconds: z.number().int().positive().optional(),
  runAt: timestampSchema.optional()
});

export const deleteScheduledPromptInputSchema = z.object({
  scheduleId: uuidSchema
});

export const createAgentSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(10_000),
  parentConversationId: uuidSchema.optional(),
  teamId: uuidSchema.optional()
});

export const sendAgentMessageInputSchema = z.object({
  sessionId: uuidSchema,
  message: z.string().trim().min(1).max(10_000)
});

export const createTeamSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  agentPrompts: z.array(z.string().trim().min(1).max(10_000)).min(1).max(8)
});

export const deleteTeamSessionInputSchema = z.object({
  teamId: uuidSchema
});

export const enterWorktreeInputSchema = z.object({
  repoRoot: z.string().trim().min(1),
  branch: z.string().trim().min(1)
});

export const exitWorktreeInputSchema = z.object({
  sessionId: uuidSchema
});

export const exportConversationInputSchema = z.object({
  conversationId: uuidSchema,
  format: z.enum(['markdown', 'json'])
});

export const exportConversationResultSchema = z.object({
  path: z.string().min(1)
});

export const editMessageInputSchema = z.object({
  messageId: uuidSchema,
  prompt: z.string().trim().min(1),
  attachments: z.array(messageAttachmentSchema).max(8).optional(),
  model: z.string().trim().min(1).optional(),
  think: ollamaThinkModeSchema.optional()
});

export const regenerateResponseInputSchema = z.object({
  assistantMessageId: uuidSchema,
  model: z.string().trim().min(1).optional(),
  think: ollamaThinkModeSchema.optional()
});

export const cancelChatTurnInputSchema = z.object({
  assistantMessageId: uuidSchema
});

export const deleteConversationInputSchema = z.object({
  conversationId: uuidSchema
});

export const pinMessageInputSchema = z.object({
  messageId: uuidSchema,
  pinned: z.boolean()
});

export const attachmentPreviewInputSchema = z.object({
  filePath: z.string().min(1)
});

export const attachmentPreviewResultSchema = z.object({
  dataUrl: z.string().min(1),
  mimeType: z.string().min(1).nullable()
});

export const openLocalPathInputSchema = z.object({
  filePath: z.string().min(1)
});

export const knowledgeDocumentsInputSchema = z.object({
  workspaceId: uuidSchema
});

export const importWorkspaceKnowledgeResultSchema = z.object({
  workspaceId: uuidSchema,
  documents: z.array(knowledgeDocumentSchema),
  skippedFiles: z.array(z.string())
});

export const chatTurnAcceptedSchema = z.object({
  requestId: uuidSchema,
  conversation: conversationSummarySchema,
  userMessage: storedMessageSchema,
  assistantMessage: storedMessageSchema,
  model: z.string().min(1)
});

export const chatStartAcceptedSchema = z.discriminatedUnion('kind', [
  chatTurnAcceptedSchema.extend({
    kind: z.literal('chat')
  }),
  z.object({
    kind: z.literal('generation'),
    requestId: uuidSchema,
    conversation: conversationSummarySchema,
    job: generationJobSchema,
    model: z.string().min(1)
  })
]);

export const generationStartResultSchema = z.object({
  job: generationJobSchema,
  conversation: conversationSummarySchema.optional()
});

export const imageGenerationStartResultSchema = generationStartResultSchema;
export const videoGenerationStartResultSchema = generationStartResultSchema;

export type GenerationStartResult = z.infer<typeof generationStartResultSchema>;
export type ImageGenerationStartResult = GenerationStartResult;
export type VideoGenerationStartResult = GenerationStartResult;

export const generationStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job-updated'),
    job: generationJobSchema
  })
]);

export const conversationExportPayloadSchema = z.object({
  conversation: conversationSummarySchema,
  workspace: workspaceSummarySchema.nullable(),
  messages: z.array(storedMessageSchema)
});

export const importConversationResultSchema = z.object({
  path: z.string().min(1),
  conversation: conversationSummarySchema,
  workspace: workspaceSummarySchema.nullable()
});

const chatStreamMessageSnapshotSchema = z.object({
  content: z.string(),
  status: messageStatusSchema,
  model: z.string().nullable().optional(),
  toolInvocationCount: z.number().int().min(0).optional(),
  toolInvocations: z.array(toolInvocationSchema).optional(),
  contextSourceCount: z.number().int().min(0).optional(),
  contextSources: z.array(contextSourceSchema).optional(),
  usage: messageUsageSchema.nullable().optional(),
  routeTrace: routeTraceSchema.nullable().optional(),
  capabilityTasks: z.array(capabilityTaskSchema).optional(),
  capabilityPlanState: planStateSchema.nullable().optional()
});

const chatStreamMessageMetadataSchema = chatStreamMessageSnapshotSchema.omit({
  content: true,
  status: true
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta'),
    requestId: uuidSchema,
    assistantMessageId: uuidSchema,
    delta: z.string(),
    content: z.string()
  }),
  z.object({
    type: z.literal('complete'),
    requestId: uuidSchema,
    assistantMessageId: uuidSchema,
    content: z.string(),
    doneReason: z.string().nullable()
  }).merge(chatStreamMessageMetadataSchema),
  z.object({
    type: z.literal('update'),
    requestId: uuidSchema,
    assistantMessageId: uuidSchema
  }).merge(chatStreamMessageSnapshotSchema),
  z.object({
    type: z.literal('message-created'),
    requestId: uuidSchema,
    conversationId: uuidSchema,
    assistantMessageId: uuidSchema,
    message: storedMessageSchema
  }),
  z.object({
    type: z.literal('error'),
    requestId: uuidSchema,
    assistantMessageId: uuidSchema,
    message: z.string(),
    recoverable: z.boolean()
  })
]);

export const conversationIdSchema = z.string().uuid();
export const messageIdSchema = z.string().uuid();

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type ConversationSearchResult = z.infer<typeof conversationSearchResultSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type ContextSource = z.infer<typeof contextSourceSchema>;
export type MessageUsage = z.infer<typeof messageUsageSchema>;
export type RouteTrace = z.infer<typeof routeTraceSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type GenerationArtifact = z.infer<typeof generationArtifactSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type StoredMessage = z.infer<typeof storedMessageSchema>;
export type ImageGenerationModelOption = z.infer<typeof imageGenerationModelOptionSchema>;
export type ImageGenerationModelCatalog = z.infer<typeof imageGenerationModelCatalogSchema>;
export type CapabilityPermission = z.infer<typeof capabilityPermissionSchema>;
export type CapabilityTask = z.infer<typeof capabilityTaskSchema>;
export type CapabilityTaskStatus = z.infer<typeof capabilityTaskStatusSchema>;
export type ScheduledPrompt = z.infer<typeof scheduledPromptSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentSession = z.infer<typeof agentSessionSchema>;
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;
export type TeamSession = z.infer<typeof teamSessionSchema>;
export type WorktreeSession = z.infer<typeof worktreeSessionSchema>;
export type PlanState = z.infer<typeof planStateSchema>;
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;
export type TextInferenceBackend = z.infer<typeof textInferenceBackendSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UpdateUserSettings = z.infer<typeof updateUserSettingsSchema>;
export type OllamaStatus = z.infer<typeof ollamaStatusSchema>;
export type NvidiaStatus = z.infer<typeof nvidiaStatusSchema>;
export type PythonStatus = z.infer<typeof pythonStatusSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type OllamaThinkMode = z.infer<typeof ollamaThinkModeSchema>;
export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;
export type ListImageGenerationModelsInput = z.infer<
  typeof listImageGenerationModelsInputSchema
>;
export type ListGenerationJobsInput = z.infer<typeof listGenerationJobsInputSchema>;
export type CancelGenerationJobInput = z.infer<typeof cancelGenerationJobInputSchema>;
export type RetryGenerationJobInput = z.infer<typeof retryGenerationJobInputSchema>;
export type ChatTurnAccepted = z.infer<typeof chatTurnAcceptedSchema>;
export type ChatStartAccepted = z.infer<typeof chatStartAcceptedSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type GenerationStreamEvent = z.infer<typeof generationStreamEventSchema>;
export type SearchConversationsInput = z.infer<typeof searchConversationsInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
export type UpdateWorkspaceRootInput = z.infer<typeof updateWorkspaceRootInputSchema>;
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceInputSchema>;
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillInputSchema>;
export type DeleteSkillInput = z.infer<typeof deleteSkillInputSchema>;
export type CapabilityPermissionInput = z.infer<typeof capabilityPermissionInputSchema>;
export type WorkspaceDirectorySelection = z.infer<
  typeof workspaceDirectorySelectionSchema
>;
export type CreateCapabilityTaskInput = z.infer<typeof createCapabilityTaskInputSchema>;
export type UpdateCapabilityTaskInput = z.infer<typeof updateCapabilityTaskInputSchema>;
export type StopCapabilityTaskInput = z.infer<typeof stopCapabilityTaskInputSchema>;
export type CreateScheduledPromptInput = z.infer<typeof createScheduledPromptInputSchema>;
export type DeleteScheduledPromptInput = z.infer<typeof deleteScheduledPromptInputSchema>;
export type CreateAgentSessionInput = z.infer<typeof createAgentSessionInputSchema>;
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageInputSchema>;
export type CreateTeamSessionInput = z.infer<typeof createTeamSessionInputSchema>;
export type DeleteTeamSessionInput = z.infer<typeof deleteTeamSessionInputSchema>;
export type EnterWorktreeInput = z.infer<typeof enterWorktreeInputSchema>;
export type ExitWorktreeInput = z.infer<typeof exitWorktreeInputSchema>;
export type ExportConversationInput = z.infer<typeof exportConversationInputSchema>;
export type ExportConversationResult = z.infer<typeof exportConversationResultSchema>;
export type EditMessageInput = z.infer<typeof editMessageInputSchema>;
export type RegenerateResponseInput = z.infer<typeof regenerateResponseInputSchema>;
export type CancelChatTurnInput = z.infer<typeof cancelChatTurnInputSchema>;
export type DeleteConversationInput = z.infer<typeof deleteConversationInputSchema>;
export type PinMessageInput = z.infer<typeof pinMessageInputSchema>;
export type AttachmentPreviewInput = z.infer<typeof attachmentPreviewInputSchema>;
export type AttachmentPreviewResult = z.infer<typeof attachmentPreviewResultSchema>;
export type OpenLocalPathInput = z.infer<typeof openLocalPathInputSchema>;
export type KnowledgeDocumentsInput = z.infer<typeof knowledgeDocumentsInputSchema>;
export type ImportWorkspaceKnowledgeResult = z.infer<
  typeof importWorkspaceKnowledgeResultSchema
>;
export type ConversationExportPayload = z.infer<typeof conversationExportPayloadSchema>;
export type ImportConversationResult = z.infer<typeof importConversationResultSchema>;
export type Unsubscribe = () => void;

export const IpcChannels = {
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickAdditionalModelsDirectory: 'settings:pick-additional-models-directory',
  systemGetStatus: 'system:get-status',
  chatStart: 'chat:start',
  generationStartImage: 'generation:start-image',
  generationStartVideo: 'generation:start-video',
  generationListImageModels: 'generation:list-image-models',
  generationListJobs: 'generation:list-jobs',
  generationCancelJob: 'generation:cancel-job',
  generationRetryJob: 'generation:retry-job',
  chatPickAttachments: 'chat:pick-attachments',
  chatEditAndResend: 'chat:edit-and-resend',
  chatRegenerateResponse: 'chat:regenerate-response',
  chatCancelTurn: 'chat:cancel-turn',
  chatDeleteConversation: 'chat:delete-conversation',
  chatPinMessage: 'chat:pin-message',
  chatGetAttachmentPreview: 'chat:get-attachment-preview',
  chatOpenLocalPath: 'chat:open-local-path',
  chatListWorkspaces: 'chat:list-workspaces',
  chatCreateWorkspace: 'chat:create-workspace',
  chatPickWorkspaceDirectory: 'chat:pick-workspace-directory',
  chatUpdateWorkspaceRoot: 'chat:update-workspace-root',
  chatDeleteWorkspace: 'chat:delete-workspace',
  chatListConversations: 'chat:list-conversations',
  chatSearchConversations: 'chat:search-conversations',
  chatGetMessages: 'chat:get-messages',
  chatGetMessage: 'chat:get-message',
  chatListTools: 'chat:list-tools',
  chatListSkills: 'chat:list-skills',
  chatCreateSkill: 'chat:create-skill',
  chatUpdateSkill: 'chat:update-skill',
  chatDeleteSkill: 'chat:delete-skill',
  chatListKnowledgeDocuments: 'chat:list-knowledge-documents',
  chatImportWorkspaceKnowledge: 'chat:import-workspace-knowledge',
  chatImportConversation: 'chat:import-conversation',
  chatExportConversation: 'chat:export-conversation',
  capabilitiesListPermissions: 'capabilities:list-permissions',
  capabilitiesGrantPermission: 'capabilities:grant-permission',
  capabilitiesRevokePermission: 'capabilities:revoke-permission',
  capabilitiesListTasks: 'capabilities:list-tasks',
  capabilitiesGetTask: 'capabilities:get-task',
  capabilitiesDeleteTask: 'capabilities:delete-task',
  capabilitiesListSchedules: 'capabilities:list-schedules',
  capabilitiesListAgents: 'capabilities:list-agents',
  capabilitiesListTeams: 'capabilities:list-teams',
  capabilitiesListWorktrees: 'capabilities:list-worktrees',
  capabilitiesGetPlanState: 'capabilities:get-plan-state',
  capabilitiesListAuditEvents: 'capabilities:list-audit-events',
  chatStreamEvent: 'chat:stream-event',
  generationStreamEvent: 'generation:stream-event'
} as const;

export interface DesktopApi {
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };
  settings: {
    get: () => Promise<UserSettings>;
    update: (input: UpdateUserSettings) => Promise<UserSettings>;
    pickAdditionalModelsDirectory: () => Promise<WorkspaceDirectorySelection>;
  };
  system: {
    getStatus: () => Promise<SystemStatus>;
  };
  generation: {
    startImage: (input: ImageGenerationRequest) => Promise<ImageGenerationStartResult>;
    startVideo: (input: VideoGenerationRequest) => Promise<VideoGenerationStartResult>;
    listImageModels: (
      input?: ListImageGenerationModelsInput
    ) => Promise<ImageGenerationModelCatalog>;
    listJobs: (input?: ListGenerationJobsInput) => Promise<GenerationJob[]>;
    cancelJob: (input: CancelGenerationJobInput) => Promise<GenerationJob>;
    retryJob: (input: RetryGenerationJobInput) => Promise<ImageGenerationStartResult>;
    onJobEvent: (listener: (event: GenerationStreamEvent) => void) => Unsubscribe;
  };
  chat: {
    start: (input: ChatTurnRequest) => Promise<ChatStartAccepted>;
    pickAttachments: () => Promise<MessageAttachment[]>;
    editAndResend: (input: EditMessageInput) => Promise<ChatTurnAccepted>;
    regenerateResponse: (input: RegenerateResponseInput) => Promise<ChatTurnAccepted>;
    cancelTurn: (input: CancelChatTurnInput) => Promise<void>;
    deleteConversation: (input: DeleteConversationInput) => Promise<void>;
    pinMessage: (input: PinMessageInput) => Promise<StoredMessage>;
    getAttachmentPreview: (input: AttachmentPreviewInput) => Promise<AttachmentPreviewResult>;
    openLocalPath: (input: OpenLocalPathInput) => Promise<void>;
    listWorkspaces: () => Promise<WorkspaceSummary[]>;
    createWorkspace: (input: CreateWorkspaceInput) => Promise<WorkspaceSummary>;
    pickWorkspaceDirectory: () => Promise<WorkspaceDirectorySelection>;
    updateWorkspaceRoot: (input: UpdateWorkspaceRootInput) => Promise<WorkspaceSummary>;
    deleteWorkspace: (input: DeleteWorkspaceInput) => Promise<void>;
    listConversations: () => Promise<ConversationSummary[]>;
    searchConversations: (input: SearchConversationsInput) => Promise<ConversationSearchResult[]>;
    getConversationMessages: (conversationId: string) => Promise<StoredMessage[]>;
    getMessage: (messageId: string) => Promise<StoredMessage | null>;
    listTools: () => Promise<ToolDefinition[]>;
    listSkills: () => Promise<SkillDefinition[]>;
    createSkill: (input: CreateSkillInput) => Promise<SkillDefinition>;
    updateSkill: (input: UpdateSkillInput) => Promise<SkillDefinition>;
    deleteSkill: (input: DeleteSkillInput) => Promise<void>;
    listKnowledgeDocuments: (input: KnowledgeDocumentsInput) => Promise<KnowledgeDocument[]>;
    importWorkspaceKnowledge: (
      input: KnowledgeDocumentsInput
    ) => Promise<ImportWorkspaceKnowledgeResult>;
    importConversation: () => Promise<ImportConversationResult>;
    exportConversation: (input: ExportConversationInput) => Promise<ExportConversationResult>;
    onStreamEvent: (listener: (event: ChatStreamEvent) => void) => Unsubscribe;
  };
  capabilities: {
    listPermissions: () => Promise<CapabilityPermission[]>;
    grantPermission: (input: CapabilityPermissionInput) => Promise<CapabilityPermission>;
    revokePermission: (input: CapabilityPermissionInput) => Promise<void>;
    listTasks: (workspaceId: string | null) => Promise<CapabilityTask[]>;
    getTask: (taskId: string) => Promise<CapabilityTask | null>;
    deleteTask: (taskId: string) => Promise<void>;
    listSchedules: () => Promise<ScheduledPrompt[]>;
    listAgents: () => Promise<AgentSession[]>;
    listTeams: () => Promise<TeamSession[]>;
    listWorktrees: () => Promise<WorktreeSession[]>;
    getPlanState: (workspaceId: string | null) => Promise<PlanState>;
    listAuditEvents: () => Promise<AuditEventRecord[]>;
  };
}

declare global {
  interface Window {
    ollamaDesktop: DesktopApi;
    helixSplash?: {
      onStatusUpdate: (
        listener: (state: { status: string; detail: string; progress: number | null }) => void
      ) => () => void;
      checkForUpdates: () => Promise<{
        currentVersion: string;
        latestVersion: string | null;
        hasUpdate: boolean;
        releaseUrl: string | null;
        publishedAt: string | null;
        latestCommit: { sha: string; message: string; date: string; url: string } | null;
        error: string | null;
      }>;
    };
  }
}
