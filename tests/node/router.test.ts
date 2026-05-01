import { describe, expect, it } from 'vitest';
import { createLogger } from '@bridge/logging/logger';
import { ChatRouter } from '@bridge/router';
import { VisionCapabilityCache } from '@bridge/ollama/vision-cache';
import { OllamaClient } from '@bridge/ollama/client';
import { defaultUserSettings } from '@bridge/settings/service';

const testLogger = createLogger('router-test');
const testVisionCache = new VisionCapabilityCache(
  { showModel: () => Promise.resolve({ details: { families: [] } }) } as unknown as OllamaClient,
  testLogger
);

const imageAttachment = {
  id: '70000000-0000-4000-8000-000000000001',
  fileName: 'person.png',
  filePath: 'E:/tmp/person.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  extractedText: null,
  createdAt: '2026-04-08T00:00:00.000Z'
};

const assistantMessageWithRoute = {
  id: '10000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000001',
  role: 'assistant' as const,
  content: 'Use the workspace docs',
  attachments: [],
  status: 'completed' as const,
  model: 'llama3.2:latest',
  correlationId: null,
  routeTrace: {
    strategy: 'rag-chat' as const,
    reason: 'workspace-knowledge-routing',
    confidence: 0.88,
    selectedModel: 'llama3.2:latest',
    fallbackModel: null,
    activeSkillId: 'grounded',
    activeToolId: null,
    usedWorkspacePrompt: true,
    usedPinnedMessages: false,
    usedRag: true,
    usedTools: false
  },
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

describe('ChatRouter', () => {
  it('prefers the explicit request model over saved defaults', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'hello',
        requestedModel: 'phi4-mini:latest',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest'
      },
      ['phi4-mini:latest', 'llama3.2:latest']
    );

    expect(decision.selectedModel).toBe('phi4-mini:latest');
    expect(decision.reason).toBe('user-selected-model');
    expect(decision.strategy).toBe('chat');
    expect(decision.activeToolId).toBeNull();
  });

  it('uses the configured coding model for code-oriented prompts in auto mode', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Create a login screen in HTML and CSS.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
    expect(decision.activeSkillId).toBe('builder');
    expect(decision.reason).toBe('auto-builder-skill');
    expect(decision.strategy).toBe('skill-chat');
  });

  it('keeps wireframe mode on the plain chat route even for HTML design prompts', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Generate a dashboard wireframe using pure HTML, CSS, and JS.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        wireframeMode: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.selectedModel).toBe('llama3.2:latest');
    expect(decision.strategy).toBe('chat');
    expect(decision.reason).toBe('wireframe-mode');
    expect(decision.activeSkillId).toBeNull();
    expect(decision.activeToolId).toBeNull();
  });

  it('uses the configured vision model for image attachments in auto mode', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Describe the clothing of this person.',
        attachments: [imageAttachment],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        visionModel: 'qwen3-vl:8b'
      },
      ['llama3.2:latest', 'qwen3-vl:8b']
    );

    expect(decision.selectedModel).toBe('qwen3-vl:8b');
    expect(decision.reason).toBe('settings-vision-model');
    expect(decision.strategy).toBe('chat');
  });

  it('keeps specialist routing for image attachments even when a general model is selected', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Describe the clothing of this person.',
        requestedModel: 'llama3.2:latest',
        attachments: [imageAttachment],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        visionModel: 'qwen3-vl:8b'
      },
      ['llama3.2:latest', 'qwen3-vl:8b']
    );

    expect(decision.selectedModel).toBe('qwen3-vl:8b');
    expect(decision.reason).toBe('vision-attachment-routing');
    expect(decision.strategy).toBe('chat');
  });

  it('falls back to the general model when a configured coding model is unavailable', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Create a login screen in HTML and CSS.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest']
    );

    expect(decision.selectedModel).toBe('llama3.2:latest');
    expect(decision.fallbackModel).toBe('qwen2.5-coder:latest');
    expect(decision.activeSkillId).toBe('builder');
    expect(decision.reason).toBe('auto-builder-skill');
    expect(decision.strategy).toBe('skill-chat');
  });

  it('keeps specialist routing for coding prompts even when a general model is selected', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Build a login screen in HTML and CSS.',
        requestedModel: 'llama3.2:latest',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
    expect(decision.activeSkillId).toBe('builder');
    expect(decision.reason).toBe('auto-builder-skill');
    expect(decision.strategy).toBe('skill-chat');
  });

  it('prefers model-assisted tool routing when the classifier selects a tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'What changed in Electron recently?',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: 'web-search',
          skillId: null,
          needsVision: false,
          prefersCode: false,
          useWorkspaceKnowledge: false,
          imageMode: 'none',
          confidence: 0.93,
          reason: 'current-events lookup'
        }
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('web-search');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.reason).toBe('model-tool-routing');
    expect(decision.confidence).toBe(0.93);
  });

  it('prefers model-assisted skill routing when the classifier selects a coding skill', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Let us ship a polished login flow end to end.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: null,
          skillId: 'builder',
          needsVision: false,
          prefersCode: true,
          useWorkspaceKnowledge: false,
          imageMode: 'none',
          confidence: 0.91,
          reason: 'implementation request'
        }
      },
      {
        ...defaultUserSettings,
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeSkillId).toBe('builder');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('model-skill-routing');
    expect(decision.confidence).toBe(0.91);
  });

  it('suppresses model-assisted workspace search when the prompt is actually a code modification request', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'In existing code implement sign-up feature as well.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: 'workspace-search',
          skillId: 'builder',
          needsVision: false,
          prefersCode: true,
          useWorkspaceKnowledge: false,
          imageMode: 'none',
          confidence: 0.9,
          reason: 'existing code lookup'
        }
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.activeSkillId).toBe('builder');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('model-skill-routing');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });

  it('suppresses model-assisted workspace listing when the prompt is actually a code modification request', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Analyze the existing code. In this, we have to implement sign-up feature as well.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: 'workspace-lister',
          skillId: 'builder',
          needsVision: false,
          prefersCode: true,
          useWorkspaceKnowledge: true,
          imageMode: 'none',
          confidence: 0.9,
          reason: 'inspect workspace before implementing'
        }
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.activeSkillId).toBe('builder');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('model-skill-routing');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });

  it('keeps Wan 2.2 prompt-authoring requests on the chat path even with a connected workspace', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Generate a prompt for Wan 2.2 image to video model.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        workspaceRootConnected: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('chat');
    expect(decision.reason).toBe('first-available-model');
    expect(decision.selectedModel).toBe('llama3.2:latest');
  });

  it('does not treat "start with" inside prompt-authoring text as a workspace opener request', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt:
          'Generate a prompt for Wan 2.2 image to video model. Start with a dynamic orbit shot.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        workspaceRootConnected: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('chat');
    expect(decision.reason).toBe('first-available-model');
  });

  it('keeps attached-image prompt-authoring requests on the chat path', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'for this image generate a prompt for wan2.2 image to video model.',
        attachments: [imageAttachment],
        recentMessages: [],
        workspaceHasKnowledge: false,
        workspaceRootConnected: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        visionModel: 'qwen3-vl:8b'
      },
      ['llama3.2:latest', 'qwen3-vl:8b']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('chat');
    expect(decision.selectedModel).toBe('qwen3-vl:8b');
  });

  it('does not route file mutation prompts to the file reader heuristically', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt:
          'Fix screenwriter_summary.md by correcting the unicode characters and save the file.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.activeSkillId).toBe('debugger');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-debugger-skill');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });

  it('suppresses model-assisted file reader routing when the prompt requests fixing and saving a file', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt:
          'In "screenwriter_summary.md" file please fix the unicode corruption and save it.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: 'file-reader',
          skillId: null,
          needsVision: false,
          prefersCode: false,
          useWorkspaceKnowledge: false,
          imageMode: 'none',
          confidence: 0.91,
          reason: 'inspect the file before making changes'
        }
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.activeSkillId).toBe('debugger');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-debugger-skill');
    expect(decision.selectedModel).toBe('llama3.2:latest');
  });

  it('carries grounded skill routing forward on follow-up prompts', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'continue with the same grounding',
        attachments: [],
        recentMessages: [assistantMessageWithRoute],
        workspaceHasKnowledge: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeSkillId).toBe('grounded');
    expect(decision.useRag).toBe(true);
    expect(decision.strategy).toBe('rag-chat');
    expect(decision.reason).toBe('follow-up-skill-carry-forward');
  });

  it('uses tool-chat for heuristic math prompts so the model can incorporate tool results', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'calculate 2 + 2 and explain the result',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('calculator');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.useTools).toBe(true);
    expect(decision.reason).toBe('math-intent-tool-routing');
  });

  it('does not misroute plain identity questions into the calculator tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'What is your name?',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('chat');
    expect(decision.useTools).toBe(false);
  });

  it('uses a direct tool route for explicit slash-tool activation', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'E:\\OllamaDesktop\\README.md',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: 'file-reader'
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('file-reader');
    expect(decision.strategy).toBe('tool');
    expect(decision.selectedModel).toBeNull();
    expect(decision.reason).toBe('explicit-tool-command');
  });

  it('does not heuristically route workspace structure prompts — the model decides via native tool-calls', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'List files in this workspace',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('chat');
  });

  it('suppresses workspace inspection tools when no workspace folder is connected', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Show me the project structure',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        workspaceRootConnected: false,
        explicitSkillId: null,
        explicitToolId: null,
        modelAnalysis: {
          toolId: 'workspace-lister',
          skillId: 'grounded',
          needsVision: false,
          prefersCode: false,
          useWorkspaceKnowledge: false,
          imageMode: 'none',
          confidence: 0.92,
          reason: 'inspect workspace before answering'
        }
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.activeSkillId).toBe('grounded');
    expect(decision.reason).toBe('model-skill-routing');
  });

  it('routes play/open media prompts to the direct workspace opener tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'play TWICE_Hare_Hare_Music_Video.mp4',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('workspace-opener');
    expect(decision.strategy).toBe('tool');
    expect(decision.selectedModel).toBeNull();
    expect(decision.reason).toBe('workspace-opener-tool-routing');
  });

  it('carries workspace tool routing forward for corrected directory replies', () => {
    const router = new ChatRouter(testLogger, testVisionCache);
    const assistantToolMessage = {
      ...assistantMessageWithRoute,
      routeTrace: {
        ...assistantMessageWithRoute.routeTrace,
        strategy: 'tool-chat' as const,
        reason: 'workspace-lister-tool-routing',
        activeSkillId: null,
        activeToolId: 'workspace-lister',
        usedRag: false,
        usedTools: true
      }
    };

    const decision = router.decide(
      {
        prompt: 'E:\\Vids is the correct directory',
        attachments: [],
        recentMessages: [assistantToolMessage],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('workspace-lister');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.reason).toBe('follow-up-tool-carry-forward');
  });

  it('routes workspace lookup prompts to the workspace search tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Find the AuthProvider component in the workspace',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBe('workspace-search');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
    expect(decision.reason).toBe('workspace-search-tool-routing');
  });

  it('routes explicit knowledge lookups to the knowledge-search tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Search the docs for authentication tokens',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('knowledge-search');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.reason).toBe('knowledge-search-tool-routing');
    expect(decision.useRag).toBe(false);
  });

  it('routes explicit current-events web prompts to the web-search tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Search the web for the latest Electron release notes',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBe('web-search');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.reason).toBe('web-search-tool-routing');
  });

  it('does not route local repository current-state prompts to web search', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Check the current state of the repository and identify issues.',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        workspaceRootConnected: true,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeToolId).toBeNull();
    expect(decision.activeSkillId).toBe('reviewer');
    expect(decision.strategy).toBe('skill-chat');
  });

  it('routes runnable JavaScript prompts to the code runner tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Run this JavaScript:\n```js\nconsole.log(2 + 2)\n```',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeToolId).toBe('code-runner');
    expect(decision.strategy).toBe('tool-chat');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
    expect(decision.reason).toBe('code-runner-tool-routing');
  });

  it('keeps browser-app implementation prompts on builder routing instead of the code runner', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: `Using HTML, CSS, and JavaScript, generate a browser OS with these features:

At least 5 applications
2 of the 5 applications must be functional 3D games
One game must be a simple GTA clone
The other 3D game can be anything
Ability to change wallpaper
Everything must be contained in a single script/file
Must run in Chrome browser`,
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeSkillId).toBe('builder');
    expect(decision.activeToolId).toBeNull();
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-builder-skill');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });

  it('auto-activates reviewer skill for review-style prompts without forcing a tool', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Review this implementation for regressions and security risks',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      defaultUserSettings,
      ['llama3.2:latest']
    );

    expect(decision.activeSkillId).toBe('reviewer');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-reviewer-skill');
    expect(decision.activeToolId).toBeNull();
  });

  it('auto-activates debugger skill for failure analysis prompts', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Debug why this React component throws an exception on mount',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeSkillId).toBe('debugger');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-debugger-skill');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });

  it('auto-activates builder skill for implementation prompts', () => {
    const router = new ChatRouter(testLogger, testVisionCache);

    const decision = router.decide(
      {
        prompt: 'Build a login screen in HTML and CSS',
        attachments: [],
        recentMessages: [],
        workspaceHasKnowledge: false,
        explicitSkillId: null,
        explicitToolId: null
      },
      {
        ...defaultUserSettings,
        codingModel: 'qwen2.5-coder:latest'
      },
      ['llama3.2:latest', 'qwen2.5-coder:latest']
    );

    expect(decision.activeSkillId).toBe('builder');
    expect(decision.strategy).toBe('skill-chat');
    expect(decision.reason).toBe('auto-builder-skill');
    expect(decision.selectedModel).toBe('qwen2.5-coder:latest');
  });
});
