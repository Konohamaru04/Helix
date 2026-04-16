# TUI Gap Fill Design

> Date: 2026-04-16
> Status: Approved

## Overview

Fill four functional gaps in the blessed-based TUI: model picker, stream cancellation, keybinding wiring, and conversation/workspace CRUD.

All actions go through existing bridge services — no direct DB/IPC from TUI.

---

## 1. Model Picker Flow

### Keybinding
- `C-m` opens model picker from any screen
- Added to `keybindings.ts` map and `TuiApp.bindKeys()`

### Behavior
- `ChatScreen.showModelPicker()` calls `createModelSelect()` component
- Populates list from `ctx.ollamaClient.listModels()`
- Modal overlays center of screen
- `select` event updates `ChatScreen.currentModel` + triggers status bar refresh
- `escape` dismisses without change
- Model persists for current session; future prompts use selected model

### Files
- `tui/keybindings.ts` — add `selectModel: 'C-m'`
- `tui/app.ts` — bind `C-m` in `bindKeys()`, delegate to `chatScreen.showModelPicker()`
- `tui/screens/chat.ts` — add `showModelPicker()` method
- `tui/components/model-select.ts` — already exists, may need minor wiring updates

---

## 2. Stream Cancel + Health Polling

### Stream Cancel
- `TuiApp` holds `currentAbortController: AbortController | null`
- On stream start (chat prompt submit), store the controller
- `C-c` during stream: calls `controller.abort()`
- Chat screen delta handler appends ` [CANCELLED]` tag to partial message in display
- Conversation history keeps the partial response marked cancelled
- When no stream is active, `C-c` refocuses input (current behavior)

### Health Polling
- `TuiApp.init()` starts `setInterval` every 30 seconds
- Calls `ctx.ollamaClient.getStatus()`
- Updates status bar with current status (running/stopped/error)
- Clears interval on `destroy()` / shutdown
- Initial check remains at startup (no change)

### Files
- `tui/app.ts` — add `currentAbortController`, bind cancel logic, add polling interval
- `tui/screens/chat.ts` — handle abort signal, append `[CANCELLED]` tag on cancel
- `tui/components/status-bar.ts` — accept and display Ollama status updates from polling

---

## 3. Keybinding Wiring

### New Keybindings
| Key | Action | Context |
|-----|--------|---------|
| `tab` | Toggle sidebar visibility | Global |
| `C-w` | Switch to workspace screen | Global |
| `C-l` | Switch to chat screen | Global |
| `?` | Open help overlay | Global |
| `C-m` | Open model picker | Global |
| `escape` / `q` | Dismiss overlay (help/model) | Overlay active |

### Help Overlay
- Full-screen `blessed.box` centered, scrollable, with border
- Lists all keybindings grouped by category:
  - **Navigation**: 1-4 screen switch, C-w, C-l, tab
  - **Chat**: C-m model picker, C-n new conversation, C-c cancel stream
  - **Workspace**: C-n create, C-d delete, C-r rename
  - **General**: C-q quit, ? help
- Reads dynamically from `keybindings.ts` map so it stays in sync
- Dismiss with `escape` or `q`

### Sidebar Toggle
- Each screen with a sidebar exposes `toggleSidebar()` method
- `tab` calls `currentScreen.toggleSidebar()` if method exists
- Toggle sets sidebar width to 0 (hidden) or original width (shown)

### Files
- `tui/keybindings.ts` — add all new entries
- `tui/app.ts` — bind all new keys, add help overlay creation
- `tui/screens/chat.ts` — add `toggleSidebar()`
- `tui/screens/workspace.ts` — add `toggleSidebar()`
- `tui/screens/generation.ts` — add `toggleSidebar()` (job list acts as sidebar)

---

## 4. Conversation + Workspace CRUD

### New Conversation (C-n)
- `C-n` in chat screen creates new conversation
- Calls `ctx.chatService.submitPrompt()` with `conversationId: undefined`
- Updates conversation sidebar with new entry
- Clears message list, focuses input

### Create Workspace (C-n on workspace screen)
- Prompt for name via blessed input box centered on screen
- Calls workspace service to create
- Refreshes workspace sidebar list

### Delete Workspace (C-d on workspace screen)
- Confirmation prompt: "Delete workspace '{name}'?"
- Calls workspace service to delete
- If deleting current workspace, switches to first available workspace
- Refreshes sidebar list

### Rename Workspace (C-r on workspace screen)
- Inline edit in sidebar list
- Shows input overlay with current name pre-filled
- Calls workspace service to rename
- Refreshes sidebar list and detail pane

### Files
- `tui/screens/chat.ts` — implement new conversation flow
- `tui/screens/workspace.ts` — add create/delete/rename methods + keybindings
- `tui/app.ts` — route `C-n` context-sensitively based on current screen

---

## Error Handling

- All CRUD operations show error in status bar on failure
- Stream cancel is graceful — no unhandled promise rejections
- Model picker shows "No models available" if Ollama is down
- Help overlay works even if bridge services fail (static keybinding list)

## Testing

- Unit tests for: `keybindings.ts` map completeness, `parseModelList`, status bar formatting
- Integration consideration: stream cancel flow, model selection round-trip