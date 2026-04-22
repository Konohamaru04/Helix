# Helix v1.0 — Diablo Patch Notes

Stable Windows release of **Helix**, a local-first AI desktop powered by Ollama.

---

## Package

- Windows archive: `Helix.v1.0.Windows.7z`
- Bundled Python runtime included
- No separate Python install required

---

## Highlights

### Core
- Deferred Python runtime startup for faster app launch
- Managed inference server lifecycle with cleaner shutdown sequencing
- Hardened bridge recovery for IPC and Python server failures
- Guarded local tools with validation before execution
- Better recovery for command-only tool output and safer workspace path detection during tool-chat turns

### Chat and skills
- DB-backed skill registry with a dedicated skills drawer for local user skills
- Incremental assistant persistence during streaming
- Lazy-loaded tool traces and source artifacts for lighter transcript rendering
- Improved grounded workspace inspection through real tool invocations
- Agent session drawer with quicker status-bar access to plans, agents, skills, and queue views

### UI
- Sidebar and footer controls reworked for chat and workspace actions
- Right-click context menus for key chat and workspace surfaces
- User messages aligned right and assistant messages aligned left with cleaner transcript presentation
- Custom scrollbars, thinking block animations, and message entrance animations
- Responsive status bar interactions and improved empty-state guidance
