# Milestone Tracker

Updated: 2026-04-11

## Milestone 1: Foundation

- [x] Electron shell
- [x] React renderer boot
- [x] preload bridge
- [x] typed IPC contracts
- [x] SQLite client and migrations
- [x] basic settings storage
- [x] basic chat UI shell
- [x] Ollama connectivity test
- [x] single-model chat request and response loop
- [x] Python server lifecycle manager
- [x] structured logging

Status: Complete

## Milestone 2: Workspaces And Chat UX

- [x] sidebar
- [x] conversations list
- [x] workspace grouping
- [x] message rendering with Markdown and GFM tables/lists
- [x] expandable thinking blocks parsed from `<think>...</think>`
- [x] search via SQLite FTS5
- [x] input bar attachments
- [x] status bar
- [x] model selector
- [x] import and export for conversations through the bridge
- [x] Enter sends and Shift+Enter inserts a newline
- [x] settings drawer selects render as native dropdowns
- [x] edit and resend for the latest user message
- [x] regenerate or retry for the latest assistant response
- [x] attachment persistence and lifecycle after send
- [x] conversation delete action in the primary chat surface
- [x] attachment previews in the composer and transcript
- [x] compact composer with `+` attachment affordance
- [x] buffered stream handling so fast model replies do not disappear in the UI
- [x] transcript auto-scroll with bounded code-block overflow handling
- [x] workspace folders can be connected from the sidebar for project-relative tool use

Status: Complete

## Milestone 3: Routing And Context

- [x] intent classifier improvements for follow-up turns
- [x] routing reason logging in the UI
- [x] richer context assembly with workspace prompt, skill prompt, pinned memory, and provenance
- [x] token usage UI
- [x] fallback handling surfaced in route metadata
- [x] hot model swap through the live model selector
- [x] pinned messages

Status: Complete

## Milestone 4: Tools And Skills

- [x] tool registry
- [x] safe tool dispatcher
- [x] code runner
- [x] file reader
- [x] calculator
- [x] workspace lister
- [x] workspace search
- [x] workspace knowledge search
- [x] workspace opener
- [x] web search
- [x] skill loader
- [x] `/` and `@` activation flows
- [x] automatic built-in skill activation heuristics
- [x] tool trace rendering

Status: Complete
Comment: The current tool surface now includes a constrained dependency-free JavaScript runner, source-linked web search, safe workspace filesystem tools, and follow-up-aware auto-routing between direct chat, tool-assisted chat, and direct tool execution.

### Milestone 4.1: Agentic Tool Surface

- [x] permission model, grant storage, and audit-event persistence
- [x] typed IPC surface for permissions, tasks, schedules, agents, teams, worktrees, plan state, and audits
- [x] `Agent`, `AskUserQuestion`, `SendMessage`, `TeamCreate`, and `TeamDelete`
- [x] `Read`, `Glob`, `Grep`, `Write`, `Edit`, `NotebookEdit`
- [x] `Bash`, `PowerShell`, `Monitor`
- [x] `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `TodoWrite`
- [x] `CronCreate`, `CronDelete`, `CronList`
- [x] `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`
- [x] `LSP`, `ToolSearch`, `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `Skill`
- [x] renderer settings surface for capability permissions and runtime state
- [x] native Ollama `/api/chat` tool exposure so models can automatically select the implemented capability surface
- [x] node and renderer coverage for permission enforcement, capability discovery, and native capability tool calls

Status: Complete
Comment: Milestone 4.1 is now a shipped implementation milestone. The bridge persists permission grants, tasks, schedules, agent sessions, worktree sessions, plan state, and audit events in SQLite; exposes them through typed preload IPC; and advertises the implemented capability set to Ollama-native tool calling so models can auto-select tools without the old manual picker UI. The original design handoff remains in [docs/tool-spike.md](./tool-spike.md).

## Milestone 5: RAG

- [x] document ingestion
- [x] chunking
- [x] embeddings
- [x] retrieval
- [x] workspace-scoped knowledge search
- [x] citation and source rendering
- [x] memory summarization and pruning

Status: Complete
Comment: Retrieval now combines SQLite FTS5 with deterministic local embeddings, and long conversations are pruned through persisted summary memory while recent turns remain raw and observable.

## Milestone 6: Generation Jobs

### Milestone 6.1: Image Generation

- [x] FastAPI generation routes
- [x] image jobs
- [x] generation job and artifact persistence
- [x] queue drawer generation cards
- [x] progress polling and typed Electron IPC updates
- [x] inline asset rendering for completed jobs
- [x] cancellation from the shared composer and queue
- [x] image-generation mode in the shared composer
- [x] image-generation settings with an additional local models directory and discovered local model selection
- [x] GGUF discovery from ComfyUI-style `diffusion_models` roots with supported text-to-image Qwen Image selection
- [x] Qwen Image Edit 2511 workflow support for text-to-image and reference-image generation, based on vendored ComfyUI workflow defaults shipped in the repo
- [x] `Auto` chat submit can now create inline text-to-image or follow-up image-edit jobs without forcing the user into manual image mode first
- [x] placeholder backend for local smoke coverage and UI testing
- [x] Python smoke tests for job start, completion, and cancellation
- [x] bridge tests for job completion, orphan reconciliation, and metadata preservation

Status: Complete
Comment: The first generation slice is now a real vertical path from renderer -> typed IPC -> Electron main -> managed FastAPI worker -> persisted queue state -> inline chat transcript rendering and queue drawer, with GGUF model discovery including a dedicated Qwen Image Edit 2511 workflow path fed by shared-composer reference attachments and `Auto` chat-submit routing for image creation/edit follow-ups.

### Milestone 6.2: VRAM Management

- [x] Python health exposes loaded image backend and VRAM telemetry
- [x] bridge system status surfaces Python model state and VRAM to the renderer
- [x] status bar shows Python worker state and CPU/GPU VRAM detail
- [x] diffusers load failures and CUDA OOMs become user-visible job failures
- [x] currently loaded image backend is reused inside the Python model manager
- [x] explicit headroom policy before loading heavier models
- [x] safe model eviction strategy across multiple generation backends
- [x] preflight rejection for clearly impossible image-job requests before enqueue

Status: Complete
Comment: The worker now enforces backend-specific GPU headroom, evicts inactive runtimes before backend/model switches, and the bridge rejects unsupported or clearly impossible image requests before they ever enter SQLite or the Python queue.

### Milestone 6.3: Queue Hardening And Notifications

- [x] orphaned pending jobs reconcile to failed after Python worker state loss
- [x] completed, failed, and cancelled jobs stay queryable in SQLite
- [x] persistent queue replay inside the Python worker itself
- [x] desktop notifications for job completion and failure
- [x] richer retry flows for failed image jobs

Status: Complete
Comment: The Python worker now persists queued and running jobs into its own restart-safe state file and replays them on boot, Electron raises desktop notifications for terminal generation outcomes, and failed or cancelled jobs can be retried directly from the chat timeline or the queue drawer.

### Milestone 6.4: Future Generation Surfaces

- [ ] video jobs
- [ ] richer asset actions and gallery management

Status: Planned

## Milestone 7: MCP

- [ ] server config UI
- [ ] connection manager
- [ ] tool manifest sync
- [ ] tool invocation
- [ ] disconnected-state handling
- [ ] resources support
- [ ] prompts support

Status: Planned

## Milestone 8: Polish And Release Hardening

- [ ] auto-update integration points
- [ ] crash recovery
- [ ] packaging hooks
- [ ] accessibility pass
- [ ] coverage pass
- [ ] security pass
- [ ] docs cleanup

Status: Planned
