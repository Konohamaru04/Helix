# Architecture

## Implemented slice

The current implementation follows the required layer boundaries:

- `renderer/` renders the UI and only talks through `window.ollamaDesktop`
- `electron/preload.ts` exposes the typed bridge
- `electron/main.ts` owns startup, splash/main BrowserWindow creation, IPC registration, and process lifecycle
- `bridge/` contains orchestration for settings, SQLite, routed chat, tools, skills, RAG, and the Python child process
- `inference_server/` hosts the FastAPI bootstrap service
- `comfyui_backend/` contains the bundled ComfyUI sidecar tree
- the production Electron main build preserves modules instead of forcing a single chunk, which keeps the packaged main-process bundle stable with the current bridge/tool graph
- packaged Windows builds copy `python_embeded/`, `inference_server/`, `comfyui_backend/`, `skills/`, and other runtime assets into Electron `resources/`, while mutable state stays under Electron `userData/`
- startup now shows a lightweight static splash window from `Assets/splash/` before `createDesktopAppContext` runs, the splash receives live main-process status updates, and the main chat window stays hidden until its renderer finishes loading
- packaged Windows builds now exclude a deferred Python dependency set from `python_embeded/`; Electron main provisions those packages into `userData/python-runtime/site-packages` on first launch before the FastAPI worker is started
- the Windows packaging scripts now enforce that release flow explicitly by stripping the deferred package set from the source `python_embeded/` tree before `electron-builder` copies runtime assets into `release/win-unpacked`

Milestone coverage today:

- Milestone 1 is complete
- Milestone 2 is complete
- Milestone 3 is complete
- Milestone 4 is complete
- Milestone 4.1 is complete
- Milestone 5 is complete
- Milestone 6.1 is complete
- Milestone 6.2 is complete
- Milestone 6.3 is complete
- Milestone 6.4 is planned

## Data flow

The routed chat flow is:

1. The user submits a prompt from the React renderer.
2. Zustand calls the typed preload API.
3. Electron main validates the payload and forwards it to `ChatService`.
4. `ChatService` first decides whether the submit should become an inline image-generation job in `Auto` mode, then otherwise persists the turn in SQLite, resolves explicit `/tool` and `@skill` directives, and asks `ChatRouter` for the route decision.
5. Optional workspace knowledge import happens for text-like attachments.
6. Optional tool execution runs inside the bridge layer.
7. `buildConversationContext` assembles workspace prompt, active skill prompt, pinned memory, retrieved knowledge, and recent turns.
   The latest user turn is normalized into a markdown envelope with `# Prompt`, optional `# Workspace`, and `# Available Tools` sections so the selected folder path and callable surface are explicit to the model.
   Workspace-bound local file tools are only advertised when the active workspace has a connected root folder.
8. For normal chat turns, `ChatService` now routes through a provider-aware text backend layer:
   - `OllamaClient` handles local Ollama chat and the native `/api/chat` tool-call loop when the model should be allowed to auto-select local tools.
   - `NvidiaClient` handles OpenAI-compatible NVIDIA chat completions through `https://integrate.api.nvidia.com/v1`.
   - Skill-routed grounded inspection turns can also escalate into the native tool loop so workspace analysis happens through real tool invocations instead of plain-text pseudo-commands.
9. Capability-backed tool calls run only through the bridge and can persist tasks, schedules, agent sessions, worktrees, plan state, permission grants, and audit events in SQLite.
10. Main proxies typed stream events back to the renderer, including graceful user-driven cancellation for in-flight replies.
11. Assistant message bodies are persisted incrementally during streaming, and route/tool/source metadata is mirrored into SQLite as it becomes available instead of waiting for the turn to finish.
12. Main proxies lightweight progress events back to the renderer with tool/source counts, while the renderer lazy-loads the heavy tool invocation and source records for an individual message only when those sections are expanded.
13. The renderer rehydrates the finished message after terminal events so route traces, token usage, and any lazily opened tool/source detail stay in sync with SQLite.

The renderer also uses the same bridge for:

- attachment picking and preview loading
- workspace listing and creation
- workspace folder picking and root-path updates
- workspace knowledge import and listing
- conversation search
- message history hydration
- message pinning
- message edit-resend and regenerate actions
- conversation import and export
- system status and settings updates
- image-generation job start, polling updates, and cancellation
- tool and skill discovery
- agent session visibility through a dedicated bottom drawer
- in-flight chat cancellation

UI layout note:

- the sidebar is intentionally navigation-only for workspace filters, search, and chat history
- workspace creation stays in the main chat surface and now requires both a name and a local folder selection up front; the composer-side workspace gear menu is limited to lightweight workspace actions such as document import
- key transcript and sidebar entities also expose custom right-click context menus so workspace, chat, and message actions are reachable without hunting for inline affordances; the workspace context menu is also where existing workspaces can connect, change, or disconnect their local folder binding
- settings open from a single header action, while the status bar stays focused on runtime health plus quick access to plan, agents, skills, and queue drawers
- when the transcript is empty, the chat surface shows a randomized feature/instruction tip instead of a fixed placeholder so the blank state can teach discovery over time

## Routing and context

The current router is heuristic but stateful enough to handle common follow-ups:

- explicit slash-tool commands
- explicit `@skill` activation
- follow-up turns like `continue`, `again`, and `use that tool again`
- role-aware model routing from Settings for General, Coding, and Vision turns
- lightweight vision routing when image attachments are present
- grounded routing when the workspace has imported knowledge
- tool-assisted routing for calculator, code-runner, file-reader, workspace-lister, workspace-search, knowledge-search, and web-search intents
- automatic skill activation for builder, debugger, reviewer, grounded, and stepwise response modes

Manual override behavior:

- the chat header model selector defaults to `Auto`
- the chat header also exposes `Text backend`, which currently switches between `Ollama` and `NVIDIA`
- `Auto` lets the bridge choose the configured General, Coding, or Vision model for each turn
- selecting a concrete specialist model in the chat header keeps that specialist for matching turns until the user switches back to `Auto`
- if the selected concrete model is a general chat model but the turn clearly needs Coding or Vision, the bridge still upgrades to the configured specialist route instead of forcing the wrong model

Current provider limits:

- the NVIDIA backend is currently wired for text chat only
- image attachments in chat context still require the Ollama multimodal path
- native tool-calling remains enabled only on the Ollama path in this slice
- when a provider emits inline tool-call markup or command-only slash-tool output, the bridge intercepts it, executes the requested local tool through the existing typed tool dispatcher, and asks the model to continue without exposing raw tool markup in the final transcript

Route decisions are persisted per assistant turn with:

- strategy
- reason
- confidence
- selected and fallback model
- active skill and tool ids
- flags for workspace prompt, pinned memory, RAG, and tool use

Context assembly is currently deterministic and observable:

- recent completed turns are capped
- pinned memory is promoted into a system block and tracked as provenance
- duplicate retrieved chunks are removed
- prompt token estimates are recorded for the UI
- chat requests now derive `num_ctx` dynamically from the assembled prompt instead of sending a fixed default; cloud models are capped at 200k per request with a 1M cumulative conversation budget, while local models scale against free host RAM and the selected Ollama model size
- included and excluded context ids are logged

## Persistence

SQLite lives under Electron `userData/data/ollama-desktop.sqlite`.

Implemented so far:

- WAL mode
- foreign keys enabled
- numbered SQL migrations
- persistent settings
- persistent workspaces
- persistent workspace root-folder bindings
- persistent conversations and messages
- incremental assistant message-body persistence during streaming turns
- normalized message attachments with extracted-text snapshots for text-like files
- pinned message memory
- assistant route metadata and token usage
- normalized tool invocations and context sources
- workspace knowledge documents and chunks
- persisted knowledge-chunk embeddings
- persisted conversation memory summaries for pruned long-running chats
- FTS5-backed conversation search
- hybrid FTS5 plus local-embedding workspace knowledge retrieval
- multimodal image forwarding to Ollama by base64-encoding local image attachments in Electron main
- migration 013: workspace-scoped capability_tasks and plan_state with composite primary key

Renderer hydration strategy:

- conversation history loads a lightweight message shape for list rendering
- heavy tool invocation payloads and RAG source excerpts are fetched per message on demand through typed IPC
- assistant markdown rendering stays plain-text while a turn is actively streaming, then upgrades to full markdown after completion

The renderer never queries SQLite directly.

Packaged runtime layout:

- read-only runtime assets are resolved from the repo root in development and from Electron `process.resourcesPath` in packaged builds
- logs now live under Electron `userData/logs`
- capability monitor output now lives under Electron `userData/capability-data`
- generated artifacts, Python worker state, and SQLite data remain under Electron `userData`

## Tools and skills

The tool stack now has two layers:

- `ToolDispatcher` for the original built-in local-workbench tools
- `CapabilityService` for the broader Milestone 4.1 agentic capability surface, with persisted permissions, stateful records, and audit events

Built-in local-workbench tools:

- `code-runner`
- `calculator`
- `file-reader`
- `workspace-lister`
- `workspace-opener`
- `workspace-search`
- `knowledge-search`
- `web-search`

Skill registry behavior:

- skills are persisted in SQLite through a bridge-owned registry table
- built-in skill markdown files are seeded into SQLite at startup and stay read-only in the UI
- legacy user markdown skills are imported into SQLite without overriding newer DB-edited versions
- route planning and capability search read skills from the DB-backed registry, not directly from renderer memory or raw files
- the renderer exposes a dedicated bottom skills drawer with a guided create/edit flow for user skills
- new user skill IDs are generated in the bridge from the skill title, deduplicated against the registry, and stay immutable after creation so routing references remain stable

Capability-backed tools and runtime actions:

- `agent`
- `ask-user-question`
- `read`
- `glob`
- `grep`
- `write`
- `edit`
- `bash`
- `powershell`
- `monitor`
- `task-create`
- `task-get`
- `task-list`
- `task-output`
- `task-stop`
- `task-update`
- `todo-write`
- `cron-create`
- `cron-delete`
- `cron-list`
- `enter-plan-mode`
- `exit-plan-mode`
- `enter-worktree`
- `exit-worktree`
- `notebook-edit`
- `lsp`
- `list-mcp-resources`
- `read-mcp-resource`
- `send-message`
- `team-create`
- `team-delete`
- `tool-search`
- `web-fetch`
- `skill`

Safety characteristics of the implemented tools:

- no renderer-side filesystem access
- code runner executes dependency-free JavaScript only inside a constrained worker-thread VM sandbox with timeout, memory limits, no imports, and captured output
- file reader is restricted to the connected workspace folder, app workspace, known attachments, and known knowledge documents
- workspace lister and workspace search stay inside the connected workspace folder only
- workspace opener stays inside the connected workspace folder and blocks executable or script file types
- knowledge search stays inside imported workspace knowledge only
- web search is read-only and returns source-linked snippets through the bridge
- relative `/read` paths resolve from the connected workspace folder only
- file size limits, directory ignore lists, and binary-file rejection are enforced
- calculator uses a local arithmetic parser rather than eval or the Function constructor
- permission grants, task state, schedule state, agent sessions, team sessions, worktree sessions, plan state, and audit events are all persisted in SQLite through the bridge
- models can now use the official Ollama `/api/chat` `tools` payload to auto-select the implemented capability surface, with bridge-side prompt translation and execution still enforced behind typed IPC and local permission rules

Skills are file-backed Markdown prompts loaded from:

- `skills/builtin`
- `skills/user`

The renderer no longer exposes manual tool or skill picker chrome in the composer. Instead, the bridge owns automatic model-assisted tool and skill selection, including native Ollama tool-calling for the implemented capability surface, while explicit directives remain available as an advanced override path.

## RAG

The current RAG slice is SQLite-native but no longer lexical-only:

- imports text-like attachments and workspace documents
- stores a content hash per knowledge document
- chunks content with overlap
- deduplicates repeated document imports by content hash
- indexes chunks in SQLite FTS5
- stores deterministic local hash embeddings per chunk
- backfills embeddings lazily for pre-existing workspaces after migration
- combines lexical and semantic scores for workspace-scoped retrieval
- renders citations and provenance in the transcript
- summarizes older conversation turns into persisted memory blocks while keeping recent turns raw
- logs included raw turn ids, summarized turn ids, and retrieved document ids for observability

## Python server

Electron main manages a localhost-only FastAPI process on the configured port.

Current behavior:

- requires `python_embeded\python.exe` as the bundled runtime
- launches the root-level `inference_server` package and lets it resolve the root-level `comfyui_backend` tree
- validates that FastAPI and Uvicorn are installed in that runtime before launch
- polls `/health` before reporting the server healthy
- logs stdout, stderr, and exits
- reuses an already-healthy managed server during development if the port is already bound
- exposes image-generation routes through `/jobs`
- keeps the active generation queue in the Python worker and mirrors durable job state into SQLite
- reports loaded image backend state and VRAM telemetry through `/health`
- on normal app quit, Electron asks the Python worker to cancel jobs, unload models, release VRAM, stop the embedded ComfyUI sidecar, and exit before the main process completes shutdown
- on abrupt Electron termination, the Python worker also watches the parent PID and self-terminates after the same cleanup path so orphaned workers do not linger in the background

Generation architecture today:

1. The renderer enters image mode from the shared composer and submits an `ImageGenerationRequest`.
2. Electron main validates the request and calls `GenerationService`.
3. `GenerationService` creates a durable `generation_jobs` row plus any later `generation_artifacts`.
4. Electron main starts the job on the managed FastAPI worker through `PythonServerManager`.
5. The Python worker queues the job, runs either the built-in placeholder backend or a diffusers pipeline, and exposes snapshots through `/jobs/:id`.
6. Electron main polls those snapshots, persists each state transition, and re-broadcasts typed job updates to renderer windows.
7. The renderer updates both the main chat transcript and the queue drawer from the same generation-job stream.

Current image backends:

- `builtin:placeholder` for fast local smoke coverage and queue/UI validation
- discovered local diffusers directories and checkpoint files from a user-configured additional models directory, including ComfyUI-style `models` roots
- architecture-aware GGUF discovery from ComfyUI-style `diffusion_models` roots, with Qwen Image text-to-image GGUF checkpoints loading through a diffusers transformer-plus-base-pipeline path
- a dedicated `qwen-image-edit-2511` workflow profile that persists mode and reference-image metadata from renderer -> Electron -> FastAPI worker -> SQLite
- Qwen Image Edit 2511 jobs reuse the shared composer attachments as reference images and apply workflow-specific defaults such as `1664x1248`, `4` steps, and the negative-prompt baseline captured from the vendored ComfyUI workflow
- when the chat header stays on `Auto`, normal text submit can auto-route clear image creation prompts into text-to-image jobs and follow-up edit prompts such as `Now swap their clothing` into image-to-image jobs that reuse the latest generated artifact as the reference input
- attached-image analysis prompts such as `Describe this image` stay on the multimodal chat path after leaving image mode, so they route to the Vision model instead of being mistaken for image generation

Current GGUF behavior:

- GGUF files are discovered without the renderer reading model files directly
- the bridge classifies GGUF families before surfacing them in Settings
- Qwen Image text-to-image GGUF checkpoints are selectable and routed through the Python worker
- Qwen Image Edit 2511 GGUF checkpoints are selectable and routed through the dedicated Qwen workflow branch in the Python worker
- Wan GGUF checkpoints stay visible but disabled until the Video Gen slice is implemented
- Qwen Image Edit GGUF checkpoints run through the vendored ComfyUI runtime that ships in this repo, so they no longer require a separate machine-level ComfyUI install; plain Qwen Image GGUF checkpoints still rely on the `Qwen/Qwen-Image` diffusers base pipeline if that separate path is selected

Current VRAM behavior:

- the Python model manager reports CUDA availability, device name, and current memory counters
- the Python worker runs a single image-generation job at a time so multiple GPU-heavy model loads do not overlap in separate job threads
- diffusers pipelines are cached only one-at-a-time, and loading a different diffusers model explicitly evicts the previous pipeline before the next allocation
- switching between diffusers and the embedded ComfyUI backend explicitly tears down the inactive runtime before the next job starts
- switching to a different ComfyUI-backed Qwen edit model restarts the embedded ComfyUI sidecar so stale model state does not accumulate across jobs
- before a fresh GPU runtime load, the worker checks a backend-specific free-VRAM headroom target and fails early with a clear error when cleanup still leaves too little free memory
- before a job is even persisted or forwarded to Python, the bridge mirrors that conservative headroom policy and rejects clearly impossible GPU requests or unsupported discovered models
- CUDA OOM failures are translated into explicit job errors instead of silent worker crashes
- the status bar surfaces CPU-worker vs GPU-worker state and current free VRAM when available

Current queue-hardening behavior:

- Electron passes a worker-owned state directory into the bundled Python process, and the Python queue persists queued or running image jobs into a restart-safe JSON file under that directory
- on worker boot, the Python queue replays persisted active jobs itself before the renderer asks for queue state, so the live worker queue survives unexpected worker restarts instead of only leaving behind SQLite history
- Electron main raises desktop notifications when an image job reaches `completed` or `failed`
- failed or cancelled jobs can be retried from both the inline transcript card and the shared queue drawer, and retries create a fresh job record instead of mutating the failed history row

## Deferred layers

The following areas are still intentionally incomplete:

- video and audio generation jobs
- external MCP server configuration, connection management, manifest sync, and prompt insertion
- inline approval prompts for risky actions

## Logging and diagnostics

Structured logs now persist to Electron `userData/logs/app.log` while also remaining visible on stdout. Existing startup, migration, routing, Python lifecycle, and capability logs are joined by explicit chat-turn entries for received prompts, accepted route decisions, bridge tool execution, native Ollama tool calls, and final assistant completions so message flow and workspace-routing mistakes can be reconstructed from disk.
