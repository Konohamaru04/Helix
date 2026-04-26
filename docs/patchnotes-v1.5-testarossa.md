# Helix v1.5 — Testarossa Patch Notes

Milestone 8 polish release of **Helix**, a local-first AI desktop powered by Ollama.

---

## Package

- Windows archive: `Helix.v1.5.Windows.7z`
- Bundled Python runtime included
- No separate Python install required

---

## Highlights

### Persistence and recovery
- Window bounds persisted across sessions (size, position, maximized state)
- Per-conversation composer drafts kept between switches and restarts
- App-state repository with dedicated SQLite migration (`017_app_state_and_drafts.sql`)
- FK cascade fix in `014_conversations_workspace_cascade.sql` — orphaned conversations cleaned on workspace delete
- Crash-recovery notes documented (`docs/crash-recovery.md`)

### Updates
- Background update polling service with status-bar update pill
- Auto-update flow documented (`docs/auto-update.md`)

### Wireframe mode
- Wireframe prompt tightened for UI-generation chat
- Renderer wireframe pipeline reworked for stability

### Security
- Electron window security hardened — `contextIsolation`, allowed-protocol allowlist, CSP review
- IPC handler audit script (`scripts/audit-ipc-handlers.mjs`) — verifies every payload-accepting handler runs `*Schema.parse()`
- Documented security checklist in release process

### Packaging
- NSIS x64 installer + portable target added to `electron-builder.yml`
- `afterPack` guard scans for leaked `.pdb` files and verifies required resources
- Version bump script (`scripts/bump-version.mjs`) — semver validation, package + lockfile sync, commit + tag

### UI polish
- Drawer chrome unified across agents, gallery, plan, queue, settings, skills
- Status-bar refinements with update pill and quicker drawer access
- Right-click context menu component shared across surfaces
- Message bubble polish for streaming + tool-trace rendering

### Accessibility
- `useEscapeClose` and `useFocusTrap` hooks for drawer keyboard nav
- Accessibility notes documented (`docs/accessibility.md`)

### Tests
- New coverage: app-state repository, update service, queue, jsonish helpers, escape-close + focus-trap hooks
- Renderer smoke tests for app-store, chat-page, gallery-drawer, generation-job-card, message-bubble, wireframe
