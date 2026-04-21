import type {
  MessageAttachment,
  RouteTrace,
  StoredMessage,
  UserSettings
} from '@bridge/ipc/contracts';
import type { Logger } from 'pino';

interface SkillIntent {
  skillId: string;
  reason: string;
}

interface ToolIntent {
  toolId: string;
  reason: string;
}

export type ModelRouteImageMode =
  | 'none'
  | 'text-to-image'
  | 'image-to-image'
  | 'prompt-authoring';

export interface ModelRouteAnalysis {
  toolId: string | null;
  skillId: string | null;
  needsVision: boolean;
  prefersCode: boolean;
  useWorkspaceKnowledge: boolean;
  imageMode: ModelRouteImageMode;
  confidence: number;
  reason: string;
}

export const MODEL_ROUTE_MIN_CONFIDENCE = 0.55;

export function isTrustedModelRouteAnalysis(
  analysis: ModelRouteAnalysis | null | undefined
): analysis is ModelRouteAnalysis {
  return Boolean(
    analysis &&
      Number.isFinite(analysis.confidence) &&
      analysis.confidence >= MODEL_ROUTE_MIN_CONFIDENCE
  );
}

function looksLikeFollowUp(prompt: string): boolean {
  return /\b(continue|same|same tool|that tool|again|fix this|do the same|use that|try again)\b/i.test(
    prompt
  );
}

function containsLikelyDirectoryPath(prompt: string): boolean {
  return /(?:[A-Za-z]:\\|\.{1,2}[\\/]|~?[\\/])[^\s"'`]+|\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\b/i.test(
    prompt
  );
}

function looksLikeMathPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();

  return (
    /^[0-9+\-*/().,%\s]+$/.test(trimmed) ||
    /^(calculate|compute|evaluate|what is|what's|solve)\b/i.test(trimmed)
  );
}

function containsLikelyFilePath(prompt: string): boolean {
  return /(?:[A-Za-z]:\\|\.{0,2}[\\/]|\/)?[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|css|html|sql|yaml|yml|toml|txt)\b/i.test(
    prompt
  );
}

function looksLikeFileMutationPrompt(prompt: string): boolean {
  return (
    /\b(fix|edit|modify|change|update|replace|rewrite|correct|repair|clean\s+up|save|write)\b/i.test(
      prompt
    ) &&
    (/\b(file|path|document|contents?|markdown|readme)\b/i.test(prompt) ||
      containsLikelyFilePath(prompt))
  );
}

function containsLikelyOpenTarget(prompt: string): boolean {
  return (
    containsLikelyDirectoryPath(prompt) ||
    /(?:[A-Za-z]:\\|\.{0,2}[\\/]|\/)?[A-Za-z0-9_.-]+\.[A-Za-z0-9]{2,6}\b/i.test(prompt)
  );
}

function looksLikeWorkspaceOpenPrompt(prompt: string): boolean {
  return (
    /\b(open|play|launch|start|watch|preview|reveal)\b/i.test(prompt) &&
    (containsLikelyOpenTarget(prompt) ||
      /\b(file|folder|directory|video|audio|song|music|image|photo|picture|document|pdf)\b/i.test(
        prompt
      ))
  );
}

function looksLikeFileReadPrompt(prompt: string): boolean {
  if (looksLikeFileMutationPrompt(prompt)) {
    return false;
  }

  return (
    /\b(read|open|show|inspect|print|summarize)\b/i.test(prompt) &&
    (/\b(file|path|document|contents?)\b/i.test(prompt) || containsLikelyFilePath(prompt))
  );
}

function looksLikeDirectoryListPrompt(prompt: string): boolean {
  return (
    /^(ls|dir)\b/i.test(prompt.trim()) ||
    (/\b(list|show|browse|display|inspect|print)\b/i.test(prompt) &&
      /\b(files?|folders?|directories?|tree|structure|project|repo|repository|workspace)\b/i.test(
        prompt
      ))
  );
}

function requiresWorkspaceRootTool(toolId: string | null | undefined): boolean {
  return ['workspace-lister', 'workspace-opener', 'workspace-search'].includes(
    toolId ?? ''
  );
}

function looksLikeWorkspaceSearchPrompt(prompt: string): boolean {
  return (
    /\b(find|search|locate|grep|where|which file|look for)\b/i.test(prompt) &&
    /\b(function|component|class|hook|route|schema|file|symbol|import|usage|definition|workspace|project|repo|repository)\b/i.test(
      prompt
    )
  );
}

function looksLikeWebSearchPrompt(prompt: string): boolean {
  return (
    /\b(search the web|search online|look online|look up online|browse the web|web search)\b/i
      .test(prompt) ||
    (/\b(latest|current|today|news|release notes|docs online|official docs)\b/i.test(prompt) &&
      /\b(search|find|look up|what(?:'s| is)|check)\b/i.test(prompt))
  );
}

function looksLikeKnowledgeSearchPrompt(prompt: string): boolean {
  return (
    /\b(search|find|look up|quote|cite|reference)\b/i.test(prompt) &&
    /\b(doc|docs|document|knowledge|notes|reference|guide|manual|workspace knowledge)\b/i.test(
      prompt
    )
  );
}

function looksLikeCodePrompt(prompt: string): boolean {
  return /\b(code|bug|typescript|javascript|python|sql|html|css|react|component|stack trace|exception|test|refactor|debug|fix)\b/i.test(
    prompt
  );
}

function looksLikeDebugPrompt(prompt: string): boolean {
  return /\b(debug|fix|broken|failing|error|issue|problem|exception|stack trace|not working|why does)\b/i.test(
    prompt
  );
}

function looksLikeReviewPrompt(prompt: string): boolean {
  return /\b(review|audit|inspect|check|regression|risk|security review|code review)\b/i.test(
    prompt
  );
}

function looksLikeStepwisePrompt(prompt: string): boolean {
  return /\b(step by step|step-by-step|steps|plan|walk me through|break it down)\b/i.test(
    prompt
  );
}

function looksLikeBuildPrompt(prompt: string): boolean {
  return /\b(create|build|implement|design|generate|write|make)\b/i.test(prompt);
}

function shouldSuppressModelWorkspaceTool(
  toolId: string | null | undefined,
  prompt: string
): boolean {
  if (
    !toolId ||
    !['workspace-search', 'workspace-lister', 'file-reader', 'read'].includes(toolId)
  ) {
    return false;
  }

  if (looksLikeFileMutationPrompt(prompt)) {
    return true;
  }

  if (!['workspace-search', 'workspace-lister'].includes(toolId)) {
    return false;
  }

  return (
    !looksLikeWorkspaceSearchPrompt(prompt) &&
    (/\bexisting code\b/i.test(prompt) ||
      ((looksLikeBuildPrompt(prompt) || looksLikeDebugPrompt(prompt)) &&
        looksLikeCodePrompt(prompt)))
  );
}

function looksLikeCodeRunnerPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  const explicitlyRequestsExecution =
    /^(?:run|execute|test|evaluate)\b/i.test(trimmed) ||
    /\b(?:run|execute|test|evaluate)\s+(?:this|the following|my)\b/i.test(prompt);

  if (!explicitlyRequestsExecution) {
    return false;
  }

  return (
    (/```/.test(prompt) ||
      /\b(?:javascript|js|node)\b/i.test(prompt) ||
      /(?:=>|console\.|const\s+|let\s+|var\s+|function\s+|class\s+|return\s+)/.test(prompt))
  );
}

function looksLikeToolCorrectionFollowUp(
  prompt: string,
  latestAssistantRoute: RouteTrace | null
): boolean {
  if (
    !latestAssistantRoute?.activeToolId ||
    !['workspace-lister', 'workspace-search', 'file-reader', 'workspace-opener'].includes(
      latestAssistantRoute.activeToolId
    )
  ) {
    return false;
  }

  const mentionsCorrection = /\b(correct|right|actual(?:ly)?|meant|instead|directory|folder|path|root)\b/i.test(
    prompt
  );
  const mentionsPath = containsLikelyDirectoryPath(prompt) || containsLikelyFilePath(prompt);

  return mentionsCorrection && mentionsPath;
}

function pickAvailableModel(
  availableModels: string[],
  candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = candidate?.trim();

    if (normalizedCandidate && availableModels.includes(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  return undefined;
}

function isVisionCapableModel(model: string): boolean {
  return /(vl|vision|llava)/i.test(model);
}

function isCodingCapableModel(model: string): boolean {
  return /(coder|code)/i.test(model);
}

function findPreferredModel(
  availableModels: string[],
  settings: UserSettings,
  options: {
    requestedModel?: string | undefined;
    needsVision: boolean;
    prefersCode: boolean;
  }
): { selectedModel: string; fallbackModel: string | null; reason: string } {
  const requestedModel = options.requestedModel?.trim();
  const normalizedAvailableModels = Array.from(
    new Set(availableModels.map((model) => model.trim()).filter(Boolean))
  );
  const requestedModelAvailable =
    requestedModel && normalizedAvailableModels.includes(requestedModel)
      ? requestedModel
      : null;

  const requestedModelUnavailable =
    requestedModel && !requestedModelAvailable
      ? requestedModel
      : null;
  const generalModel = pickAvailableModel(normalizedAvailableModels, [
    settings.defaultModel,
    normalizedAvailableModels[0]
  ]);

  if (options.needsVision) {
    if (requestedModelAvailable && isVisionCapableModel(requestedModelAvailable)) {
      return {
        selectedModel: requestedModelAvailable,
        fallbackModel: null,
        reason: 'user-selected-model'
      };
    }

    const visionModel = pickAvailableModel(normalizedAvailableModels, [
      settings.visionModel,
      normalizedAvailableModels.find((model) => /(vl|vision|llava)/i.test(model))
    ]);

    if (visionModel) {
      return {
        selectedModel: visionModel,
        fallbackModel:
          requestedModelUnavailable ??
          (requestedModelAvailable && requestedModelAvailable !== visionModel
            ? requestedModelAvailable
            : null) ??
          (generalModel && generalModel !== visionModel ? generalModel : null),
        reason:
          requestedModelUnavailable !== null
            ? 'requested-model-unavailable'
            : requestedModelAvailable !== null
              ? 'vision-attachment-routing'
              : settings.visionModel.trim() &&
                  visionModel === settings.visionModel.trim()
              ? 'settings-vision-model'
              : 'vision-attachment-routing'
      };
    }

    if (requestedModelAvailable) {
      return {
        selectedModel: requestedModelAvailable,
        fallbackModel: requestedModelUnavailable ?? null,
        reason: 'user-selected-model'
      };
    }

    if (generalModel) {
      return {
        selectedModel: generalModel,
        fallbackModel:
          requestedModelUnavailable ??
          (settings.visionModel.trim() || null),
        reason:
          requestedModelUnavailable !== null
            ? 'requested-model-unavailable'
            : 'vision-routed-to-general'
      };
    }
  }

  if (options.prefersCode) {
    if (requestedModelAvailable && isCodingCapableModel(requestedModelAvailable)) {
      return {
        selectedModel: requestedModelAvailable,
        fallbackModel: null,
        reason: 'user-selected-model'
      };
    }

    const codingModel = pickAvailableModel(normalizedAvailableModels, [
      settings.codingModel,
      normalizedAvailableModels.find((model) => /(coder|code)/i.test(model))
    ]);

    if (codingModel) {
      return {
        selectedModel: codingModel,
        fallbackModel:
          requestedModelUnavailable ??
          (requestedModelAvailable && requestedModelAvailable !== codingModel
            ? requestedModelAvailable
            : null) ??
          (generalModel && generalModel !== codingModel ? generalModel : null),
        reason:
          requestedModelUnavailable !== null
            ? 'requested-model-unavailable'
            : requestedModelAvailable !== null
              ? 'code-intent-routing'
              : settings.codingModel.trim() &&
                  codingModel === settings.codingModel.trim()
              ? 'settings-coding-model'
              : 'code-intent-routing'
      };
    }

    if (requestedModelAvailable) {
      return {
        selectedModel: requestedModelAvailable,
        fallbackModel: requestedModelUnavailable ?? null,
        reason: 'user-selected-model'
      };
    }

    if (generalModel) {
      return {
        selectedModel: generalModel,
        fallbackModel:
          requestedModelUnavailable ??
          (settings.codingModel.trim() || null),
        reason:
          requestedModelUnavailable !== null
            ? 'requested-model-unavailable'
            : 'coding-routed-to-general'
      };
    }
  }

  if (requestedModelAvailable) {
    return {
      selectedModel: requestedModelAvailable,
      fallbackModel: null,
      reason: 'user-selected-model'
    };
  }

  const selectedModel = generalModel;

  if (!selectedModel) {
    throw new Error(
      'No Ollama model is configured. Set a default model in Settings or pull one with Ollama.'
    );
  }

  return {
    selectedModel,
    fallbackModel: requestedModelUnavailable,
    reason:
      requestedModelUnavailable !== null
        ? 'requested-model-unavailable'
        : settings.defaultModel.trim() && selectedModel === settings.defaultModel.trim()
          ? 'settings-general-model'
          : 'first-available-model'
  };
}

function detectAutoSkillIntent(
  prompt: string,
  workspaceHasKnowledge: boolean
): SkillIntent | null {
  if (workspaceHasKnowledge && /\b(source|cite|citation|according to|reference|knowledge|docs?|manual|guide)\b/i.test(prompt)) {
    return {
      skillId: 'grounded',
      reason: 'auto-grounded-skill'
    };
  }

  if (looksLikeReviewPrompt(prompt)) {
    return {
      skillId: 'reviewer',
      reason: 'auto-reviewer-skill'
    };
  }

  if (looksLikeDebugPrompt(prompt)) {
    return {
      skillId: 'debugger',
      reason: 'auto-debugger-skill'
    };
  }

  if (looksLikeStepwisePrompt(prompt)) {
    return {
      skillId: 'stepwise',
      reason: 'auto-stepwise-skill'
    };
  }

  if (looksLikeBuildPrompt(prompt) && looksLikeCodePrompt(prompt)) {
    return {
      skillId: 'builder',
      reason: 'auto-builder-skill'
    };
  }

  return null;
}

function detectHeuristicToolIntent(
  prompt: string,
  workspaceHasKnowledge: boolean,
  workspaceRootConnected: boolean
): ToolIntent | null {
  if (looksLikeKnowledgeSearchPrompt(prompt) && workspaceHasKnowledge) {
    return {
      toolId: 'knowledge-search',
      reason: 'knowledge-search-tool-routing'
    };
  }

  if (looksLikeWebSearchPrompt(prompt)) {
    return {
      toolId: 'web-search',
      reason: 'web-search-tool-routing'
    };
  }

  if (looksLikeCodeRunnerPrompt(prompt)) {
    return {
      toolId: 'code-runner',
      reason: 'code-runner-tool-routing'
    };
  }

  if (workspaceRootConnected && looksLikeWorkspaceOpenPrompt(prompt)) {
    return {
      toolId: 'workspace-opener',
      reason: 'workspace-opener-tool-routing'
    };
  }

  if (looksLikeFileReadPrompt(prompt)) {
    return {
      toolId: 'file-reader',
      reason: 'file-reader-tool-routing'
    };
  }

  if (workspaceRootConnected && looksLikeDirectoryListPrompt(prompt)) {
    return {
      toolId: 'workspace-lister',
      reason: 'workspace-lister-tool-routing'
    };
  }

  if (workspaceRootConnected && looksLikeWorkspaceSearchPrompt(prompt)) {
    return {
      toolId: 'workspace-search',
      reason: 'workspace-search-tool-routing'
    };
  }

  if (looksLikeMathPrompt(prompt)) {
    return {
      toolId: 'calculator',
      reason: 'math-intent-tool-routing'
    };
  }

  return null;
}

export interface RouteInput {
  prompt: string;
  requestedModel?: string | undefined;
  attachments: MessageAttachment[];
  recentMessages: StoredMessage[];
  workspaceHasKnowledge: boolean;
  workspaceRootConnected?: boolean;
  explicitSkillId: string | null;
  explicitToolId: string | null;
  modelAnalysis?: ModelRouteAnalysis | null;
}

export interface RouteDecision {
  selectedModel: string | null;
  fallbackModel: string | null;
  strategy: RouteTrace['strategy'];
  reason: string;
  confidence: number;
  activeSkillId: string | null;
  activeToolId: string | null;
  useRag: boolean;
  useTools: boolean;
}

export class ChatRouter {
  constructor(private readonly logger: Logger) {}

  decide(
    input: RouteInput,
    settings: UserSettings,
    availableModels: string[]
  ): RouteDecision {
    const trustedModelAnalysis = isTrustedModelRouteAnalysis(input.modelAnalysis)
      ? input.modelAnalysis
      : null;
    const suppressedModelToolId =
      shouldSuppressModelWorkspaceTool(trustedModelAnalysis?.toolId, input.prompt)
        ? trustedModelAnalysis?.toolId ?? null
        : null;
    const latestAssistantRoute =
      [...input.recentMessages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.routeTrace)?.routeTrace ?? null;
    const workspaceRootConnected = input.workspaceRootConnected ?? true;
    const followUp =
      looksLikeFollowUp(input.prompt) ||
      looksLikeToolCorrectionFollowUp(input.prompt, latestAssistantRoute);
    const shouldUseHeuristics =
      trustedModelAnalysis === null || suppressedModelToolId !== null;
    const heuristicToolIntent = shouldUseHeuristics
      ? detectHeuristicToolIntent(
          input.prompt,
          input.workspaceHasKnowledge,
          workspaceRootConnected
        )
      : null;
    const autoSkillIntent = shouldUseHeuristics
      ? detectAutoSkillIntent(input.prompt, input.workspaceHasKnowledge)
      : null;
    const modelSkillIntent =
      trustedModelAnalysis?.skillId !== null && trustedModelAnalysis?.skillId !== undefined
        ? {
            skillId: trustedModelAnalysis.skillId,
            reason: 'model-skill-routing'
          }
        : null;
    const modelToolIntent =
      suppressedModelToolId === null &&
      trustedModelAnalysis?.toolId !== null &&
      trustedModelAnalysis?.toolId !== undefined &&
      (workspaceRootConnected || !requiresWorkspaceRootTool(trustedModelAnalysis.toolId))
        ? {
            toolId: trustedModelAnalysis.toolId,
            reason: 'model-tool-routing'
          }
        : null;

    if (suppressedModelToolId) {
      this.logger.info(
        {
          suppressedToolId: suppressedModelToolId,
          confidence: trustedModelAnalysis?.confidence ?? null,
          classifierReason: trustedModelAnalysis?.reason ?? null
        },
        'Ignored model-assisted workspace inspection tool for a code modification prompt'
      );
    }
    const activeSkillIntent =
      input.explicitSkillId !== null
        ? {
            skillId: input.explicitSkillId,
            reason: 'explicit-skill-activation'
          }
        : modelSkillIntent ??
          (shouldUseHeuristics && followUp && latestAssistantRoute?.activeSkillId
          ? {
              skillId: latestAssistantRoute.activeSkillId,
              reason: 'follow-up-skill-carry-forward'
            }
          : null) ??
          autoSkillIntent;
    const activeToolIntent =
      input.explicitToolId !== null
        ? {
            toolId: input.explicitToolId,
            reason: 'explicit-tool-command'
          }
        : modelToolIntent ??
          heuristicToolIntent ??
          (shouldUseHeuristics &&
          followUp &&
          latestAssistantRoute?.activeToolId &&
          (workspaceRootConnected ||
            !requiresWorkspaceRootTool(latestAssistantRoute.activeToolId))
            ? {
                toolId: latestAssistantRoute.activeToolId,
                reason: 'follow-up-tool-carry-forward'
              }
            : null);
    const activeSkillId = activeSkillIntent?.skillId ?? null;
    const activeToolId = activeToolIntent?.toolId ?? null;
    const needsVision =
      trustedModelAnalysis?.needsVision ??
      input.attachments.some(
        (attachment) => attachment.mimeType?.startsWith('image/') === true
      );
    const prefersCode =
      trustedModelAnalysis?.prefersCode ?? looksLikeCodePrompt(input.prompt);
    const shouldUseRag =
      activeToolId === 'knowledge-search'
        ? false
        : input.workspaceHasKnowledge &&
          (activeSkillId === 'grounded' ||
            Boolean(trustedModelAnalysis?.useWorkspaceKnowledge) ||
            (shouldUseHeuristics &&
              (/\b(source|doc|document|knowledge|reference|according to)\b/i.test(input.prompt) ||
                (followUp && Boolean(latestAssistantRoute?.usedRag)))));
    const shouldUseTools = Boolean(activeToolId);
    const shouldUseDirectTool =
      shouldUseTools &&
      (input.explicitToolId !== null || activeToolId === 'workspace-opener');
    const strategy: RouteTrace['strategy'] =
      shouldUseRag && shouldUseTools
        ? 'rag-tool'
        : shouldUseRag
          ? 'rag-chat'
          : shouldUseTools
            ? shouldUseDirectTool
              ? 'tool'
              : 'tool-chat'
            : activeSkillId
              ? 'skill-chat'
              : 'chat';

    if (activeToolId && activeToolIntent?.reason === 'follow-up-tool-carry-forward') {
      this.logger.info(
        { activeToolId, reason: activeToolIntent.reason },
        'Carried forward tool route from recent context'
      );
    }

    if (activeToolId && activeToolIntent?.reason === 'model-tool-routing') {
      this.logger.info(
        {
          activeToolId,
          confidence: trustedModelAnalysis?.confidence ?? null,
          classifierReason: trustedModelAnalysis?.reason ?? null
        },
        'Resolved model-assisted tool routing'
      );
    }

    if (activeSkillId && activeSkillIntent?.reason === 'follow-up-skill-carry-forward') {
      this.logger.info(
        { activeSkillId, reason: activeSkillIntent.reason },
        'Carried forward skill route from recent context'
      );
    }

    if (activeSkillId && activeSkillIntent && activeSkillIntent.reason.startsWith('auto-')) {
      this.logger.info(
        { activeSkillId, reason: activeSkillIntent.reason },
        'Resolved automatic skill activation'
      );
    }

    if (activeSkillId && activeSkillIntent?.reason === 'model-skill-routing') {
      this.logger.info(
        {
          activeSkillId,
          confidence: trustedModelAnalysis?.confidence ?? null,
          classifierReason: trustedModelAnalysis?.reason ?? null
        },
        'Resolved model-assisted skill routing'
      );
    }

    if (activeToolId) {
      const modelSelection =
        strategy === 'tool'
          ? null
          : findPreferredModel(availableModels, settings, {
              requestedModel: input.requestedModel,
              needsVision,
              prefersCode
            });

      this.logger.info(
        { toolId: activeToolId, strategy, reason: activeToolIntent?.reason },
        'Resolved tool route'
      );

      return {
        selectedModel: modelSelection?.selectedModel ?? null,
        fallbackModel: modelSelection?.fallbackModel ?? null,
        strategy,
        reason: activeToolIntent?.reason ?? 'tool-routing',
        confidence:
          input.explicitToolId || input.explicitSkillId
            ? 1
            : trustedModelAnalysis?.confidence ??
              (strategy === 'rag-tool'
                ? 0.9
                : 0.84),
        activeSkillId,
        activeToolId,
        useRag: shouldUseRag,
        useTools: true
      };
    }

    const modelSelection = findPreferredModel(availableModels, settings, {
      requestedModel: input.requestedModel,
      needsVision,
      prefersCode
    });
    const reason =
      activeSkillIntent?.reason ??
      (shouldUseRag
        ? trustedModelAnalysis?.useWorkspaceKnowledge
          ? 'model-knowledge-routing'
          : 'workspace-knowledge-routing'
        : modelSelection.reason);

    this.logger.info(
      {
        strategy,
        selectedModel: modelSelection.selectedModel,
        fallbackModel: modelSelection.fallbackModel,
        reason
      },
      'Resolved chat model'
    );

    return {
      selectedModel: modelSelection.selectedModel,
      fallbackModel: modelSelection.fallbackModel,
      strategy,
      reason,
      confidence:
        input.explicitSkillId || input.explicitToolId
          ? 1
          : trustedModelAnalysis?.confidence ??
            (shouldUseRag || needsVision
              ? 0.88
              : activeSkillId
                ? 0.82
                : 0.72),
      activeSkillId,
      activeToolId: null,
      useRag: shouldUseRag,
      useTools: false
    };
  }
}
