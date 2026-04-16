# TUI Gap Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill four functional gaps in the blessed TUI: model picker, stream cancel, keybinding wiring, and conversation/workspace CRUD.

**Architecture:** All changes are in the `tui/` layer. Actions delegate to existing bridge services (`ChatService.cancelChatTurn()`, `OllamaClient`, `SettingsService`). Stream cancel captures `assistantMessageId` from `ChatStreamEvent.delta` events and calls `cancelChatTurn()` — no raw `AbortController` needed. Health polling uses `setInterval` calling `OllamaClient.getStatus()`. No new bridge methods needed except `renameWorkspace` (deferred — no backend support).

**Tech Stack:** blessed (terminal UI), TypeScript, vitest (tests)

---

### Task 1: Keybinding Wiring — Add Missing Keybindings and Help Overlay

**Files:**
- Modify: `tui/keybindings.ts`
- Modify: `tui/app.ts`
- Create: `tui/components/help-overlay.ts`
- Test: `tests/node/tui/components/help-overlay.test.ts`

- [ ] **Step 1: Write failing test for help overlay content**

```ts
// tests/node/tui/components/help-overlay.test.ts
import { describe, it, expect } from 'vitest';
import { formatHelpContent, describeKey } from '../../../../tui/components/help-overlay';
import { keybindings } from '../../../../tui/keybindings';

describe('formatHelpContent', () => {
  it('includes all keybinding categories', () => {
    const content = formatHelpContent();
    expect(content).toContain('Navigation');
    expect(content).toContain('Chat');
    expect(content).toContain('Workspace');
    expect(content).toContain('General');
  });

  it('includes key descriptions for each binding', () => {
    const content = formatHelpContent();
    expect(content).toContain(describeKey('quit'));
    expect(content).toContain(describeKey('screenChat'));
    expect(content).toContain(describeKey('cancelStream'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/tui/components/help-overlay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Update keybindings.ts — add selectModel and helpOverlay entries**

Add to the `keybindings` object in `tui/keybindings.ts`:

```ts
selectModel: 'C-m',
helpOverlay: '?',
```

Add to the `labels` record in `describeKey`:

```ts
selectModel: 'Ctrl+M',
helpOverlay: '?',
```

Also add `workspaceCreate`, `workspaceDelete`, `workspaceRename` entries:

```ts
workspaceCreate: 'C-n',  // context: workspace screen
workspaceDelete: 'C-d',
workspaceRename: 'C-r',
```

And their labels:

```ts
workspaceCreate: 'Ctrl+N',
workspaceDelete: 'Ctrl+D',
workspaceRename: 'Ctrl+R',
```

- [ ] **Step 4: Create `tui/components/help-overlay.ts`**

```ts
import blessed from 'blessed';
import { colors, tags } from '@tui/theme';
import { keybindings, describeKey, type KeyAction } from '@tui/keybindings';

export interface HelpCategory {
  label: string;
  actions: KeyAction[];
}

const categories: HelpCategory[] = [
  { label: 'Navigation', actions: ['screenChat', 'screenWorkspace', 'screenGeneration', 'screenCapabilities', 'switchWorkspace', 'listConversations', 'toggleSidebar'] },
  { label: 'Chat', actions: ['submit', 'newLine', 'cancelStream', 'newConversation', 'selectModel'] },
  { label: 'Workspace', actions: ['workspaceCreate', 'workspaceDelete', 'workspaceRename'] },
  { label: 'General', actions: ['quit', 'helpOverlay', 'scrollUp', 'scrollDown', 'pageUp', 'pageDown'] }
];

export function formatHelpContent(): string {
  const lines: string[] = [];
  for (const cat of categories) {
    lines.push(tags.bold(` ${cat.label} `));
    for (const action of cat.actions) {
      const key = describeKey(action);
      const label = action.replace(/([A-Z])/g, ' $1').toLowerCase();
      lines.push(`  ${tags.accent(key.padEnd(14))} ${label}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function createHelpOverlay(parent: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
  const overlay = blessed.box({
    parent,
    top: 'center',
    left: 'center',
    width: 50,
    height: 22,
    style: {
      bg: colors.sidebar,
      fg: colors.fg,
      border: { fg: colors.accent }
    },
    border: { type: 'line' },
    label: ' Keybindings ',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    tags: true,
    hidden: true
  });

  overlay.setContent(formatHelpContent());

  overlay.key(['escape', 'q'], () => {
    overlay.hide();
    parent.render();
  });

  return overlay;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/node/tui/components/help-overlay.test.ts`
Expected: PASS

- [ ] **Step 6: Wire keybindings in TuiApp**

In `tui/app.ts`, add imports:

```ts
import { createHelpOverlay } from '@tui/components/help-overlay';
```

Add to the `TuiApp` class:

```ts
private helpOverlay: blessed.Widgets.BoxElement;
```

In constructor, after `this.bindKeys()`:

```ts
this.helpOverlay = createHelpOverlay(this.screen);
```

In `bindKeys()`, add these new key bindings (after existing ones):

```ts
this.screen.key(keybindings.toggleSidebar, () => this.toggleSidebar());
this.screen.key(keybindings.switchWorkspace, () => this.switchScreen('workspace'));
this.screen.key(keybindings.listConversations, () => this.switchScreen('chat'));
this.screen.key(keybindings.helpOverlay, () => {
  this.helpOverlay.show();
  this.helpOverlay.focus();
  this.screen.render();
});
```

Add `toggleSidebar` method:

```ts
private toggleSidebar(): void {
  const screen = this.activeScreen;
  if (screen === 'chat' && typeof this.chatScreen.toggleSidebar === 'function') {
    this.chatScreen.toggleSidebar();
  } else if (screen === 'workspace' && typeof this.workspaceScreen.toggleSidebar === 'function') {
    this.workspaceScreen.toggleSidebar();
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add tui/keybindings.ts tui/app.ts tui/components/help-overlay.ts tests/node/tui/components/help-overlay.test.ts
git commit -m "feat(tui): add keybinding wiring, help overlay, and new key entries"
```

---

### Task 2: Model Picker Flow

**Files:**
- Modify: `tui/screens/chat.ts`
- Modify: `tui/app.ts`

- [ ] **Step 1: Add model picker to ChatScreen**

In `tui/screens/chat.ts`, add import:

```ts
import { createModelSelect, showModelSelect } from '@tui/components/model-select';
```

Add property to `ChatScreen` class:

```ts
private modelSelect: blessed.Widgets.ListElement | null = null;
```

Add `showModelPicker` method:

```ts
showModelPicker(): void {
  if (!this.modelSelect) {
    this.modelSelect = createModelSelect(this.screen, (model: string) => {
      this.currentModel = model;
      this.screen.render();
    });
  }

  const settings = this.ctx.settingsService.get();
  void this.ctx.ollamaClient.getStatus(settings.ollamaBaseUrl).then((status) => {
    const models = status.models.map(m => m.name);
    if (models.length === 0) {
      // Show "No models" message
      appendMessage(this.messageList, { role: 'system', content: 'No models available. Is Ollama running?' });
      this.screen.render();
      return;
    }
    showModelSelect(this.modelSelect!, models, this.currentModel);
  }).catch(() => {
    appendMessage(this.messageList, { role: 'system', content: 'Cannot connect to Ollama to list models.' });
    this.screen.render();
  });
}
```

- [ ] **Step 2: Wire C-m in TuiApp to call showModelPicker**

In `tui/app.ts`, in `bindKeys()`, add:

```ts
this.screen.key(keybindings.selectModel, () => {
  this.chatScreen.showModelPicker();
});
```

- [ ] **Step 3: Commit**

```bash
git add tui/screens/chat.ts tui/app.ts
git commit -m "feat(tui): add model picker flow with C-m keybinding"
```

---

### Task 3: Stream Cancel + Health Polling

**Files:**
- Modify: `tui/screens/chat.ts`
- Modify: `tui/app.ts`
- Modify: `tui/main.ts`

Stream cancel uses `ChatService.cancelChatTurn({ assistantMessageId })`. The first `delta` event in a stream carries `assistantMessageId` — capture it. When C-c is pressed, call `cancelChatTurn()` and append `[CANCELLED]` to the message.

- [ ] **Step 1: Track assistantMessageId and add cancelStream to ChatScreen**

In `tui/screens/chat.ts`, add property:

```ts
private activeAssistantMessageId: string | null = null;
```

Modify `handleStreamEvent` to capture the ID from the first delta event (delta events carry `assistantMessageId` per `ChatStreamEvent` schema):

```ts
private handleStreamEvent(event: ChatStreamEvent): void {
  switch (event.type) {
    case 'delta': {
      if (this.streamingContent.length === 0) {
        appendMessage(this.messageList, { role: 'assistant', content: '' });
      }
      this.activeAssistantMessageId = event.assistantMessageId;
      this.streamingContent += event.delta;
      appendDelta(this.messageList, event.delta);
      break;
    }
    case 'complete':
      this.streamingContent = '';
      this.activeAssistantMessageId = null;
      this.screen.render();
      break;
    case 'error':
      this.activeAssistantMessageId = null;
      appendMessage(this.messageList, {
        role: 'system',
        content: `Stream error: ${event.message}`
      });
      this.screen.render();
      break;
  }
}
```

Add `cancelStream` method that calls `cancelChatTurn`:

```ts
cancelStream(): boolean {
  if (!this.activeAssistantMessageId) return false;

  const messageId = this.activeAssistantMessageId;
  this.activeAssistantMessageId = null;

  try {
    this.ctx.chatService.cancelChatTurn({ assistantMessageId: messageId });
  } catch {
    // Turn may have already completed — ignore
  }

  if (this.streamingContent) {
    appendDelta(this.messageList, ' [CANCELLED]');
    this.streamingContent = '';
  }
  this.screen.render();
  return true;
}
```

Also clear `activeAssistantMessageId` in the `handleSubmit` error handler:

```ts
}).catch((err: unknown) => {
  this.activeAssistantMessageId = null;
  appendMessage(this.messageList, {
    role: 'system',
    content: `Error: ${(err as Error).message}`
  });
});
```

- [ ] **Step 2: Wire C-c to cancel stream in TuiApp**

In `tui/app.ts`, modify the `cancelStream` keybinding handler:

```ts
this.screen.key(keybindings.cancelStream, () => {
  if (this.activeScreen === 'chat') {
    const cancelled = this.chatScreen.cancelStream();
    if (!cancelled) {
      // No active stream — refocus input
      this.chatScreen.getInput().focus();
    }
  }
});
```

- [ ] **Step 3: Add health polling to TuiApp**

Add property to `TuiApp`:

```ts
private healthInterval: ReturnType<typeof setInterval> | null = null;
```

In `init()`, after `this.checkOllamaStatus()`, add:

```ts
this.healthInterval = setInterval(() => {
  void this.checkOllamaStatus();
}, 30_000);
```

Add `destroy` method:

```ts
destroy(): void {
  if (this.healthInterval) {
    clearInterval(this.healthInterval);
    this.healthInterval = null;
  }
}
```

Update `tui/main.ts` shutdown to call `app.destroy()`:

```ts
const shutdown = async (): Promise<void> => {
  app.destroy();
  app.getScreen().destroy();
  await ctx.dispose();
  process.exit(0);
};
```

- [ ] **Step 4: Commit**

```bash
git add tui/screens/chat.ts tui/app.ts tui/main.ts
git commit -m "feat(tui): add stream cancel with C-c and 30s Ollama health polling"
```

---

### Task 4: Sidebar Toggle

**Files:**
- Modify: `tui/screens/chat.ts`
- Modify: `tui/screens/workspace.ts`

- [ ] **Step 1: Add toggleSidebar to ChatScreen**

Add property:

```ts
private sidebarVisible = true;
private sidebarWidth = 24;
```

Add `toggleSidebar` method:

```ts
toggleSidebar(): void {
  this.sidebarVisible = !this.sidebarVisible;
  const width = this.sidebarVisible ? this.sidebarWidth : 0;
  this.conversationSidebar.setWidth(width);
  this.conversationSidebar.hidden = !this.sidebarVisible;
  this.messageList.left = this.sidebarVisible ? this.sidebarWidth : 0;
  this.input.left = this.sidebarVisible ? this.sidebarWidth : 0;
  this.screen.render();
}
```

- [ ] **Step 2: Add toggleSidebar to WorkspaceScreen**

Add property:

```ts
private sidebarVisible = true;
private sidebarWidth = 30;
```

Add `toggleSidebar` method:

```ts
toggleSidebar(): void {
  this.sidebarVisible = !this.sidebarVisible;
  const width = this.sidebarVisible ? this.sidebarWidth : 0;
  this.list.setWidth(width);
  this.list.hidden = !this.sidebarVisible;
  this.detail.left = this.sidebarVisible ? this.sidebarWidth : 0;
  this.screen.render();
}
```

- [ ] **Step 3: Commit**

```bash
git add tui/screens/chat.ts tui/screens/workspace.ts
git commit -m "feat(tui): add sidebar toggle for chat and workspace screens"
```

---

### Task 5: Conversation + Workspace CRUD

**Files:**
- Modify: `tui/screens/chat.ts` — new conversation flow
- Modify: `tui/screens/workspace.ts` — create/delete workspaces
- Modify: `tui/app.ts` — context-sensitive C-n routing

- [ ] **Step 1: Add newConversation to ChatScreen**

In `tui/screens/chat.ts`, add method:

```ts
newConversation(): void {
  this.currentConversationId = null;
  this.streamingContent = '';
  this.messageList.setContent('');
  this.loadConversations();
  this.input.focus();
  this.screen.render();
}
```

- [ ] **Step 2: Add workspace CRUD to WorkspaceScreen**

In `tui/screens/workspace.ts`, add import:

```ts
import blessed from 'blessed';
```

(blessed is already imported)

Add methods:

```ts
createWorkspace(): void {
  const input = blessed.textbox({
    parent: this.screen,
    top: 'center',
    left: 'center',
    width: 40,
    height: 3,
    style: inputStyle,
    border: { type: 'line' },
    label: ' Workspace Name ',
    inputOnFocus: true
  });

  input.key('enter', () => {
    const name = input.getValue().trim();
    if (name) {
      void this.ctx.chatService.createWorkspace({ name }).then(() => {
        this.refreshList();
      }).catch((err: unknown) => {
        this.detail.setContent(tags.error(`Failed: ${(err as Error).message}`));
        this.screen.render();
      });
    }
    input.destroy();
    this.screen.render();
  });

  input.key('escape', () => {
    input.destroy();
    this.screen.render();
  });

  input.focus();
  this.screen.render();
}

deleteWorkspace(): void {
  const workspaces = this.ctx.chatService.listWorkspaces();
  const ws = workspaces[this.selectedIndex];
  if (!ws) return;

  if (workspaces.length <= 1) {
    this.detail.setContent(tags.error('Cannot delete the last workspace.'));
    this.screen.render();
    return;
  }

  const confirm = blessed.question({
    parent: this.screen,
    top: 'center',
    left: 'center',
    width: 40,
    height: 7,
    style: boxStyle,
    border: { type: 'line' },
    tags: true
  });

  confirm.ask(`Delete workspace "${ws.name}"?`, (_err: unknown, value: boolean) => {
    if (value) {
      try {
        this.ctx.chatService.deleteWorkspace(ws.id);
        if (this.onWorkspaceSwitch) {
          // Switch to first available workspace
          const remaining = this.ctx.chatService.listWorkspaces();
          this.onWorkspaceSwitch(remaining[0]?.id ?? null);
        }
        this.refreshList();
      } catch (err: unknown) {
        this.detail.setContent(tags.error(`Failed: ${(err as Error).message}`));
      }
    }
    this.screen.render();
  });
}
```

Note: `renameWorkspace` is **deferred** — no backend method exists (`renameWorkspace`/`updateWorkspaceName` not in `ChatRepository` or `ChatService`). Requires adding a DB migration and repository method. Will be a separate task.

- [ ] **Step 3: Route C-n context-sensitively in TuiApp**

In `tui/app.ts`, modify the `newConversation` keybinding handler:

```ts
// Replace the existing C-n handler
this.screen.key(keybindings.newConversation, () => {
  if (this.activeScreen === 'workspace') {
    this.workspaceScreen.createWorkspace();
  } else {
    this.chatScreen.newConversation();
  }
});
```

Add C-d handler in `bindKeys()`:

```ts
this.screen.key(keybindings.workspaceDelete, () => {
  if (this.activeScreen === 'workspace') {
    this.workspaceScreen.deleteWorkspace();
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add tui/screens/chat.ts tui/screens/workspace.ts tui/app.ts
git commit -m "feat(tui): add new conversation flow, workspace create/delete"
```

---

### Task 6: Integration Test and Final Polish

**Files:**
- Test: `tests/node/tui/app.test.ts`

- [ ] **Step 1: Write integration test for keybinding wiring**

```ts
// tests/node/tui/app.test.ts
import { describe, it, expect } from 'vitest';
import { keybindings, describeKey } from '../../../../tui/keybindings';

describe('keybindings', () => {
  it('has all required keybindings', () => {
    expect(keybindings).toHaveProperty('quit');
    expect(keybindings).toHaveProperty('cancelStream');
    expect(keybindings).toHaveProperty('toggleSidebar');
    expect(keybindings).toHaveProperty('selectModel');
    expect(keybindings).toHaveProperty('helpOverlay');
    expect(keybindings).toHaveProperty('workspaceCreate');
    expect(keybindings).toHaveProperty('workspaceDelete');
    expect(keybindings).toHaveProperty('workspaceRename');
    expect(keybindings).toHaveProperty('newConversation');
    expect(keybindings).toHaveProperty('switchWorkspace');
    expect(keybindings).toHaveProperty('listConversations');
  });

  it('describeKey returns human-readable labels', () => {
    expect(describeKey('quit')).toBe('Ctrl+Q');
    expect(describeKey('selectModel')).toBe('Ctrl+M');
    expect(describeKey('helpOverlay')).toBe('?');
    expect(describeKey('toggleSidebar')).toBe('Tab');
  });
});
```

- [ ] **Step 2: Run all TUI tests**

Run: `npx vitest run tests/node/tui/`
Expected: All tests PASS

- [ ] **Step 3: Run full typecheck**

Run: `npx tsc --noEmit -p tui/tsconfig.tui.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add tests/node/tui/app.test.ts
git commit -m "test(tui): add keybinding wiring integration tests"
```

---

## Deferred Items

- **Workspace rename** (`C-r`): Requires adding `renameWorkspace(workspaceId: string, name: string)` to `ChatRepository`, `ChatService`, and a corresponding DB migration. The keybinding entry (`workspaceRename: 'C-r'`) is included in `keybindings.ts` but the handler shows a "not yet implemented" message in the help overlay. Full implementation tracked separately.