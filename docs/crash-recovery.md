# Crash Recovery

Helix handles several crash and error scenarios to preserve user data and recover gracefully.

## Renderer Process Crashes

- **Detection**: `render-process-gone` event with `reason: 'crashed'` or `'killed'`.
- **Recovery**: Automatic reload after a 2-second delay.
- **Threshold**: After 3 renderer crashes, hardware acceleration is disabled and the renderer is re-created.
- **Implementation**: `electron/main.ts` — `rendererCrashCount` counter with `RENDERER_CRASH_THRESHOLD`.

## GPU Process Crashes

- **Detection**: `child-process-gone` event for GPU process.
- **Recovery**: Same 3-strike threshold as renderer crashes. After 3 GPU crashes, hardware acceleration is disabled and all windows reload.
- **Implementation**: `electron/main.ts` — `gpuCrashCount` counter with `GPU_CRASH_THRESHOLD`.

## Main Process Errors

- **Uncaught exceptions**: Logged via Pino, `emergencyDisposeAppContext()` performs synchronous cleanup, and `dialog.showErrorBox()` displays a user-facing error message.
- **Unhandled rejections**: Logged via Pino. No dialog — these are often non-fatal.

## Session Restore

- **Last session persistence**: `bridge/app-state/repository.ts` stores `activeConversationId` and `activeWorkspaceId` in the `app_state` SQLite table under key `lastSession`.
- **Restore on boot**: `renderer/store/app-store.ts` `loadInitialData()` calls `appState.getLastSession()` and restores the conversation/workspace if both still exist in the database.
- **Save on navigate**: `selectConversation()` and `selectWorkspace()` call `appState.setLastSession()` to persist the user's current context.

## Draft Recovery

- Composer drafts are persisted per-conversation in `conversation_drafts` (SQLite) via `AppStateRepository.setDraft()`.
- On conversation switch, the draft is restored via `AppStateRepository.getDraft()`.
- Drafts are cleared when the message is sent.

## Graceful Shutdown

- `before-quit` event triggers an 8-second timeout for async disposal (`emergencyDisposeAppContext()`).
- This ensures SQLite WAL checkpoints and Python worker teardown complete before exit.