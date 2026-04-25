# Security

## Current boundaries

The implemented slice enforces these constraints already:

- renderer code cannot call Node APIs directly
- preload exposes a narrow, typed API surface only
- IPC payloads are validated with `zod`
- Ollama and Python calls are orchestrated only from Electron main and bridge services
- remote NVIDIA chat calls are also orchestrated only from Electron main and bridge services
- attachment selection and knowledge import are mediated by Electron-owned file dialogs
- exported conversations strip local attachment file paths before writing shareable files
- file previews are served through typed IPC and only for known attachment paths
- Python image-generation routes stay localhost-only and are reachable only through Electron main
- generated image output paths are chosen by the bridge under the app-owned data directory rather than by the renderer
- deferred packaged Python dependencies are installed into Electron `userData/python-runtime` instead of modifying packaged `resources/python_embeded`

## Implemented tool safety

The current tool surface is broader than the original built-in slice and remains guarded:

- `calculator` uses a local arithmetic parser instead of eval or dynamic function construction
- `code-runner` executes dependency-free JavaScript only inside a worker-thread VM sandbox with explicit host-API blocking, timeout enforcement, memory ceilings, captured stdio, and temp-directory cleanup
- `file-reader` only reads:
  - relative paths inside a user-connected workspace folder
  - files inside the app workspace
  - files already attached to a message
  - files already imported into workspace knowledge
- `workspace-lister` and `workspace-search` only inspect the explicitly connected workspace folder and never traverse outside it
- `workspace-opener` only opens paths inside the connected workspace folder and refuses executable or script extensions
- `workspace-search` skips known heavy directories and refuses oversized or binary-looking files
- `knowledge-search` reads only from imported workspace knowledge already stored in SQLite
- `web-search` is read-only, query-limited, and runs through Electron main rather than from the renderer
- the capability surface adds `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`, `PowerShell`, `Monitor`, `NotebookEdit`, `Task*`, `TodoWrite`, `Cron*`, `Agent`, `SendMessage`, `Team*`, `Enter/ExitPlanMode`, `Enter/ExitWorktree`, `LSP`, `ToolSearch`, `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, and `Skill`
- risky capability tools are gated by persisted permission grants and write audit events for grants, denials, starts, completions, and failures
- `write` and `edit` stay inside the app workspace or the explicitly connected workspace folder
- `bash`, `powershell`, and `monitor` run with bounded output capture and timeout enforcement for foreground commands
- duplicate workspace-folder bindings are rejected so one local project is not silently shared across multiple workspaces
- `file-reader` enforces a size ceiling and rejects binary-looking content

This keeps the current tool slice inside explicit local boundaries even when write-capable or command-capable tools are enabled.

## Current generation safety

The current image-generation slice also keeps a few important boundaries:

- the renderer never talks directly to FastAPI; all generation traffic goes through typed preload IPC
- generation jobs are validated before they cross the bridge
- the Python worker only binds to `127.0.0.1`
- cancellation and progress updates are proxied back through Electron rather than exposed directly to the renderer
- CUDA OOM failures are converted into explicit job failures instead of leaving the worker in a silent crash loop
- generated artifacts are persisted locally under the app data directory and referenced through normalized job/artifact tables
- the placeholder backend provides a no-download fallback for test/dev flows when a real diffusers model is unavailable

## Wireframe preview safety

Wireframe mode is text-model driven and does not call the Python generation server. The renderer parses a fenced `wireframe` JSON block from assistant output and renders the latest design in an iframe sandboxed with `allow-scripts` only. Design artifacts are ignored unless their `html` field contains inline markup, so model outputs like `See index.html` do not become broken previews. The generated preview document includes a restrictive Content Security Policy: no default network access, no `connect-src`, no frames, no form actions, and inline-only CSS/JavaScript. The bridge prompt also instructs the model not to use remote assets, imports, `fetch`, browser storage, local file paths, or iframes.

Wireframe exports are client-side standalone `.html` downloads from the parsed preview document. They are not written to arbitrary local paths by the bridge.

## Current limitations

These items are still not fully implemented and remain explicitly deferred:

- secret storage for external credentials
- NVIDIA API keys are currently stored in app settings so the bridge can reuse them, but they are not yet protected by an OS credential vault
- prompt-injection defenses for RAG and MCP content
- inline chat-native approval prompts for destructive tools
- richer human-readable scope previews for future external or multi-workspace risky actions
- full MCP server trust and write-capable MCP confirmation flows

## Immediate next security work

The next security milestones should add:

- inline risky-action confirmation prompts
- external-secret storage and redaction, including moving NVIDIA API keys out of plain settings persistence
- prompt-injection hardening for imported knowledge and future MCP surfaces
- explicit external MCP trust and secret-handling rules

## Planned agentic tool permission model

Milestone 4.1 now implements three active enforcement states plus one deferred state:

- `No approval`: safe read-only or interaction-only capabilities inside explicit local or conversational boundaries
- `Confirm once`: stateful but not inherently destructive actions that should require a scoped grant for the current workspace or session
- `Always confirm`: any write, shell, long-running command, notebook mutation, or arbitrary remote fetch surface
- `Blocked by policy until implemented`: capabilities that must not be surfaced until their owning subsystem, audit path, and tests exist

See [tool-spike.md](./tool-spike.md) for the tool-by-tool mapping.
